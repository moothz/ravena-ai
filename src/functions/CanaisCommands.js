const fs = require("fs");
const path = require("path");
const chrono = require("chrono-node");
const mime = require("mime-types");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");

const logger = new Logger("canais-commands");
const database = Database.getInstance();
const DB_NAME = "canais";
const MAX_CANAIS_POR_GRUPO = 7;
const BACKFILL_COUNT = 30;

// Diretório base para mídias
const MEDIA_DIR = path.join(__dirname, "../../data/media/canais");
if (!fs.existsSync(MEDIA_DIR)) {
	fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Inicialização do Banco SQLite
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS canais (
    jid TEXT PRIMARY KEY,
    invite TEXT,
    link TEXT,
    nome_oficial TEXT,
    descricao TEXT,
    criado_em INTEGER
  );

  CREATE TABLE IF NOT EXISTS canal_grupos (
    group_id TEXT NOT NULL,
    canal_jid TEXT NOT NULL,
    apelido TEXT NOT NULL,
    apelido_normalizado TEXT NOT NULL,
    tipos_midia TEXT,
    encaminhar INTEGER DEFAULT 0,
    criado_por TEXT,
    criado_em INTEGER,
    PRIMARY KEY (group_id, canal_jid),
    UNIQUE (group_id, apelido_normalizado)
  );

  CREATE TABLE IF NOT EXISTS canal_posts (
    canal_jid TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    ts INTEGER,
    dia TEXT NOT NULL,
    tipo TEXT NOT NULL,
    texto TEXT,
    arquivo TEXT,
    mimetype TEXT,
    PRIMARY KEY (canal_jid, msg_id)
  );

  CREATE INDEX IF NOT EXISTS idx_canal_posts_dia ON canal_posts(canal_jid, dia);
  CREATE INDEX IF NOT EXISTS idx_canal_grupos_group ON canal_grupos(group_id);
`,
	true
);

// Migração retroativa para tabelas já existentes
(async () => {
	try {
		await database.dbRun(
			DB_NAME,
			"ALTER TABLE canal_grupos ADD COLUMN encaminhar INTEGER DEFAULT 0"
		);
	} catch (e) {
		// Coluna já existe
	}
})();

// Cache em memória dos canais monitorados (JID -> Set de tipos permitidos em todos os grupos ou 'all')
let monitoredChannelsCache = new Map();
let cacheLoaded = false;

/**
 * Atualiza o cache em memória dos canais monitorados
 */
async function refreshTrackedChannelsCache() {
	try {
		const rows = await database.dbAll(
			DB_NAME,
			"SELECT DISTINCT canal_jid, tipos_midia, encaminhar FROM canal_grupos"
		);
		const newMap = new Map();

		for (const row of rows) {
			if (!newMap.has(row.canal_jid)) {
				newMap.set(row.canal_jid, new Set());
			}
			const set = newMap.get(row.canal_jid);
			if (!row.tipos_midia) {
				set.add("all");
			} else {
				try {
					const types = JSON.parse(row.tipos_midia);
					if (Array.isArray(types)) {
						types.forEach((t) => set.add(t));
					}
				} catch (e) {
					set.add("all");
				}
			}
		}

		monitoredChannelsCache = newMap;
		cacheLoaded = true;
	} catch (error) {
		logger.error("Erro ao carregar cache de canais monitorados:", error);
	}
}

// Inicializa o cache
refreshTrackedChannelsCache();

/**
 * Normaliza strings para busca/comparação (sem acentos, minúsculas, trim)
 */
function normalizeString(str) {
	if (!str || typeof str !== "string") return "";
	return str
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim();
}

/**
 * Gera string de data atual (YYYY-MM-DD) no fuso de Brasília
 */
function getTodayBrasilia(referenceDate = new Date()) {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Sao_Paulo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	});
	const parts = dtf.formatToParts(referenceDate);
	const map = {};
	for (const p of parts) {
		map[p.type] = p.value;
	}
	return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Converte timestamp (segundos ou ms ou Date) para YYYY-MM-DD em Brasília
 */
function timestampToDayBrasilia(ts) {
	let date;
	if (typeof ts === "number") {
		date = ts < 10000000000 ? new Date(ts * 1000) : new Date(ts);
	} else if (typeof ts === "string") {
		const num = Number(ts);
		date = isNaN(num) ? new Date(ts) : num < 10000000000 ? new Date(num * 1000) : new Date(num);
	} else if (ts instanceof Date) {
		date = ts;
	} else {
		date = new Date();
	}

	return getTodayBrasilia(date);
}

/**
 * Normaliza os tipos de mídias informados pelo usuário
 * Tipos canônicos: texto, imagem, audio, sticker, video, documento
 */
function parseMediaTypes(typesStr) {
	if (!typesStr || typeof typesStr !== "string" || typesStr.trim() === "") {
		return null;
	}

	const rawParts = typesStr.split(/\s*,\s*/);
	const validMap = {
		texto: "texto",
		text: "texto",
		chat: "texto",
		imagem: "imagem",
		image: "imagem",
		img: "imagem",
		foto: "imagem",
		photo: "imagem",
		audio: "audio",
		áudio: "audio",
		som: "audio",
		voice: "audio",
		voz: "audio",
		sticker: "sticker",
		figurinha: "sticker",
		fig: "sticker",
		stk: "sticker",
		video: "video",
		vídeo: "video",
		vid: "video",
		gif: "video",
		documento: "documento",
		doc: "documento",
		arquivo: "documento",
		file: "documento"
	};

	const result = new Set();
	const invalid = [];

	for (const part of rawParts) {
		const clean = normalizeString(part);
		if (!clean) continue;
		if (clean === "todas" || clean === "todos" || clean === "all") {
			return null;
		}
		if (validMap[clean]) {
			result.add(validMap[clean]);
		} else {
			invalid.push(part.trim());
		}
	}

	if (invalid.length > 0) {
		return {
			valid: false,
			error: `Tipos de mídia inválidos: *${invalid.join(", ")}*.\nTipos suportados: *texto, imagem, audio, sticker, video, documento*.`
		};
	}

	return {
		valid: true,
		types: Array.from(result)
	};
}

/**
 * Extrai o nome (apelido) e o link do canal a partir dos argumentos
 */
function parseNameAndLink(inputStr) {
	if (!inputStr || typeof inputStr !== "string") {
		return null;
	}

	const linkRegex =
		/(https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[a-zA-Z0-9_-]+|whatsapp\.com\/channel\/[a-zA-Z0-9_-]+)/i;
	const match = inputStr.match(linkRegex);

	if (!match) {
		if (inputStr.includes("chat.whatsapp.com")) {
			return {
				error:
					"❌ O link informado é de um grupo (chat.whatsapp.com).\nUse um link de canal do WhatsApp: https://whatsapp.com/channel/..."
			};
		}
		return {
			error:
				"❌ Link de canal não encontrado!\nFormato esperado: `!canal-seguir <nome> https://whatsapp.com/channel/...`"
		};
	}

	const rawLink = match[0];
	const fullLink = rawLink.startsWith("http") ? rawLink : `https://${rawLink}`;

	// Nome é tudo antes do link (ou após se inverterem)
	const beforeLink = inputStr.substring(0, match.index).trim();
	const afterLink = inputStr.substring(match.index + rawLink.length).trim();
	const rawName = beforeLink || afterLink;

	return {
		link: fullLink,
		rawName: rawName || null
	};
}

/**
 * Parser de data flexível (hoje, ontem, DD/MM/YYYY, YYYY-MM-DD, linguagem natural)
 */
function parseDateInput(dateExpression) {
	if (!dateExpression || typeof dateExpression !== "string") {
		return getTodayBrasilia();
	}

	const lowerExpr = normalizeString(dateExpression);

	if (lowerExpr === "hoje") {
		return getTodayBrasilia();
	}
	if (lowerExpr === "ontem") {
		return getTodayBrasilia(new Date(Date.now() - 24 * 60 * 60 * 1000));
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(dateExpression.trim())) {
		return dateExpression.trim();
	}

	// DD/MM/YYYY ou DD-MM-YYYY ou DD/MM
	const dmyMatch = dateExpression.trim().match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/);
	if (dmyMatch) {
		const day = dmyMatch[1].padStart(2, "0");
		const month = dmyMatch[2].padStart(2, "0");
		const year = dmyMatch[3] || getTodayBrasilia().split("-")[0];
		return `${year}-${month}-${day}`;
	}

	// Extração textual "dd de mês de yyyy"
	const textDateRegex = /(\d{1,2})\s+de\s+([\wÇç]+)(?:\s+de\s+(\d{4}))?/i;
	const matchText = dateExpression.match(textDateRegex);
	if (matchText) {
		const monthMap = {
			janeiro: "01",
			fevereiro: "02",
			março: "03",
			marco: "03",
			abril: "04",
			maio: "05",
			junho: "06",
			julho: "07",
			agosto: "08",
			setembro: "09",
			outubro: "10",
			novembro: "11",
			dezembro: "12"
		};
		const day = matchText[1].padStart(2, "0");
		const month = monthMap[matchText[2].toLowerCase()];
		const year = matchText[3] || getTodayBrasilia().split("-")[0];
		if (month) {
			return `${year}-${month}-${day}`;
		}
	}

	// Chrono natural language
	const defaultDate = getTodayBrasilia();
	const [dYear, dMonth, dDay] = defaultDate.split("-").map(Number);
	const referenceDate = new Date(Date.UTC(dYear, dMonth - 1, dDay, 12, 0, 0));
	const parsedDate = chrono.pt.parse(dateExpression, referenceDate, { forwardDate: false });

	if (parsedDate && parsedDate.length > 0) {
		const resultDate = parsedDate[0].start.date();
		const rYear = resultDate.getUTCFullYear();
		const rMonth = String(resultDate.getUTCMonth() + 1).padStart(2, "0");
		const rDay = String(resultDate.getUTCDate()).padStart(2, "0");
		return `${rYear}-${rMonth}-${rDay}`;
	}

	return null;
}

/**
 * Normaliza o tipo de mensagem para salvar no banco
 */
function classifyMessageType(msgType) {
	if (!msgType) return "texto";
	const lower = msgType.toLowerCase();
	if (lower.includes("image") || lower === "imagem") return "imagem";
	if (lower.includes("audio") || lower === "ptt" || lower === "voz") return "audio";
	if (lower.includes("video") || lower === "gif") return "video";
	if (lower.includes("sticker")) return "sticker";
	if (lower.includes("document") || lower === "documento") return "documento";
	return "texto";
}

/**
 * Salva um arquivo de mídia no diretório seguro de canais
 */
function saveMediaFile(canalJid, msgId, bufferOrBase64, extension) {
	try {
		const safeJid = canalJid.replace(/[^a-zA-Z0-9_-]/g, "_");
		const channelDir = path.join(MEDIA_DIR, safeJid);
		if (!fs.existsSync(channelDir)) {
			fs.mkdirSync(channelDir, { recursive: true });
		}

		const ext = extension ? extension.replace(/^\./, "") : "bin";
		const fileName = `${msgId}.${ext}`;
		const targetPath = path.join(channelDir, fileName);

		if (Buffer.isBuffer(bufferOrBase64)) {
			fs.writeFileSync(targetPath, bufferOrBase64);
		} else if (typeof bufferOrBase64 === "string") {
			const cleanBase64 = bufferOrBase64.replace(/^data:.*?;base64,/, "");
			fs.writeFileSync(targetPath, Buffer.from(cleanBase64, "base64"));
		}

		return path.relative(path.join(__dirname, "../.."), targetPath);
	} catch (error) {
		logger.error("Erro ao salvar arquivo de mídia de canal:", error);
		return null;
	}
}

/**
 * Puxa e salva as últimas 30 mensagens de um canal recém-seguido
 */
async function backfillRecentMessages(bot, canalJid, tiposMidiaArray = null) {
	try {
		if (!bot?.apiClient) return 0;
		logger.info(
			`[Canais] Iniciando backfill de ${BACKFILL_COUNT} mensagens para canal ${canalJid}...`
		);

		const res = await bot.apiClient.post("/newsletter/messages", {
			jid: canalJid,
			count: BACKFILL_COUNT
		});

		const messages = res?.data || res?.messages || [];
		if (!Array.isArray(messages) || messages.length === 0) {
			logger.info(`[Canais] Nenhuma mensagem retornada no backfill de ${canalJid}.`);
			return 0;
		}

		let savedCount = 0;
		for (const item of messages) {
			try {
				const msgId = item.MessageID || item.id;
				if (!msgId) continue;

				// Verifica se já existe
				const existing = await database.dbGet(
					DB_NAME,
					"SELECT 1 FROM canal_posts WHERE canal_jid = ? AND msg_id = ?",
					[canalJid, msgId]
				);
				if (existing) continue;

				const ts = item.Timestamp ? new Date(item.Timestamp).getTime() : Date.now();
				const dia = timestampToDayBrasilia(ts);
				const rawMsg = item.Message || {};

				// Identifica tipo e conteúdo
				let tipo = "texto";
				let texto = "";
				let mediaMsg = null;
				let mimetype = null;

				if (rawMsg.imageMessage) {
					tipo = "imagem";
					mediaMsg = rawMsg.imageMessage;
					texto = rawMsg.imageMessage.caption || "";
					mimetype = rawMsg.imageMessage.mimetype || "image/jpeg";
				} else if (rawMsg.audioMessage) {
					tipo = "audio";
					mediaMsg = rawMsg.audioMessage;
					mimetype = rawMsg.audioMessage.mimetype || "audio/ogg";
				} else if (rawMsg.videoMessage) {
					tipo = "video";
					mediaMsg = rawMsg.videoMessage;
					texto = rawMsg.videoMessage.caption || "";
					mimetype = rawMsg.videoMessage.mimetype || "video/mp4";
				} else if (rawMsg.stickerMessage) {
					tipo = "sticker";
					mediaMsg = rawMsg.stickerMessage;
					mimetype = rawMsg.stickerMessage.mimetype || "image/webp";
				} else if (rawMsg.documentMessage) {
					tipo = "documento";
					mediaMsg = rawMsg.documentMessage;
					texto = rawMsg.documentMessage.caption || rawMsg.documentMessage.fileName || "";
					mimetype = rawMsg.documentMessage.mimetype || "application/octet-stream";
				} else {
					tipo = "texto";
					texto =
						rawMsg.conversation ||
						rawMsg.extendedTextMessage?.text ||
						item.body ||
						item.content ||
						"";
				}

				// Enquetes ou mensagens especiais vazias
				if (rawMsg.pollCreationMessage || rawMsg.pollCreationMessageV3) {
					continue; // Ignora enquetes conforme pedido
				}

				let arquivo = null;
				const shouldDownloadMedia =
					mediaMsg && (!tiposMidiaArray || tiposMidiaArray.includes(tipo));

				if (shouldDownloadMedia) {
					try {
						const dlRes = await bot.apiClient.post("/message/downloadmedia", {
							message: rawMsg
						});
						if (dlRes?.data?.base64) {
							const ext = mime.extension(mimetype) || (tipo === "sticker" ? "webp" : "bin");
							arquivo = saveMediaFile(canalJid, msgId, dlRes.data.base64, ext);
						}
					} catch (dlErr) {
						logger.warn(
							`[Canais] Falha no download de mídia do post ${msgId}: ${dlErr.message || dlErr}`
						);
					}
				}

				await database.dbRun(
					DB_NAME,
					`INSERT OR IGNORE INTO canal_posts (canal_jid, msg_id, ts, dia, tipo, texto, arquivo, mimetype)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[canalJid, msgId, ts, dia, tipo, texto, arquivo, mimetype]
				);

				savedCount++;
			} catch (itemErr) {
				logger.error(`[Canais] Erro ao processar mensagem individual do backfill:`, itemErr);
			}
		}

		logger.info(`[Canais] Backfill concluído para ${canalJid}: ${savedCount} mensagens salvas.`);
		return savedCount;
	} catch (error) {
		logger.error(`[Canais] Erro ao executar backfill de ${canalJid}:`, error);
		return 0;
	}
}

/**
 * Detector de mensagens de canais invocado pelo EventHandler
 */
async function detectPost(bot, message) {
	try {
		if (!message || !message.isNewsletter) return false;

		const channelJid = message.from;
		if (!channelJid) return false;

		// Ignora se não houver canais no cache ou se este canal não for monitorado
		if (!cacheLoaded) await refreshTrackedChannelsCache();
		if (!monitoredChannelsCache.has(channelJid)) {
			return false;
		}

		const msgId = message.id || message.origin?.id?._serialized_v3 || message.origin?.id?.id;
		if (!msgId) return false;

		// Deduplicação
		const existing = await database.dbGet(
			DB_NAME,
			"SELECT 1 FROM canal_posts WHERE canal_jid = ? AND msg_id = ?",
			[channelJid, msgId]
		);
		if (existing) return true;

		const ts = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();
		const dia = timestampToDayBrasilia(ts);
		const tipo = classifyMessageType(message.type);
		const texto = message.body || message.caption || message.content || "";

		// Enquetes: ignora
		if (message.goMessageData?.pollCreationMessage || message.type === "poll") {
			return false;
		}

		let arquivo = null;
		let mimetype = null;

		// Verifica se algum grupo quer essa mídia
		const allowedSet = monitoredChannelsCache.get(channelJid);
		const wantsMedia =
			message.hasMedia && allowedSet && (allowedSet.has("all") || allowedSet.has(tipo));

		if (wantsMedia && typeof message.downloadMedia === "function") {
			try {
				const media = await message.downloadMedia();
				if (media && (media.data || media.filePath)) {
					mimetype = media.mimetype || null;
					const ext =
						mime.extension(mimetype) ||
						(media.filename ? path.extname(media.filename) : null) ||
						(tipo === "sticker" ? "webp" : "bin");

					if (media.filePath && fs.existsSync(media.filePath)) {
						const safeJid = channelJid.replace(/[^a-zA-Z0-9_-]/g, "_");
						const channelDir = path.join(MEDIA_DIR, safeJid);
						if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });
						const targetPath = path.join(channelDir, `${msgId}.${ext.replace(/^\./, "")}`);
						fs.copyFileSync(media.filePath, targetPath);
						arquivo = path.relative(path.join(__dirname, "../.."), targetPath);
					} else if (media.data) {
						arquivo = saveMediaFile(channelJid, msgId, media.data, ext);
					}
				}
			} catch (downloadErr) {
				logger.error(
					`[Canais] Erro ao baixar mídia do post ${msgId} de ${channelJid}:`,
					downloadErr
				);
			}
		}

		await database.dbRun(
			DB_NAME,
			`INSERT OR IGNORE INTO canal_posts (canal_jid, msg_id, ts, dia, tipo, texto, arquivo, mimetype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[channelJid, msgId, ts, dia, tipo, texto, arquivo, mimetype]
		);

		logger.info(`[Canais] Post ${msgId} capturado de ${channelJid} (tipo: ${tipo}, dia: ${dia})`);

		// Encaminhamento automático em tempo real para grupos com encaminhar = 1
		try {
			const forwardingGroups = await database.dbAll(
				DB_NAME,
				"SELECT group_id, apelido, tipos_midia FROM canal_grupos WHERE canal_jid = ? AND encaminhar = 1",
				[channelJid]
			);

			if (forwardingGroups && forwardingGroups.length > 0) {
				const postData = {
					canal_jid: channelJid,
					msg_id: msgId,
					ts,
					dia,
					tipo,
					texto,
					arquivo,
					mimetype
				};

				for (const grp of forwardingGroups) {
					try {
						if (grp.tipos_midia) {
							const allowed = JSON.parse(grp.tipos_midia);
							if (Array.isArray(allowed) && !allowed.includes(tipo)) {
								continue;
							}
						}

						const postReturnMsg = await createPostReturnMessage(
							bot,
							grp.group_id,
							postData,
							grp.apelido,
							true
						);

						if (postReturnMsg && typeof bot.sendReturnMessages === "function") {
							postReturnMsg.delay = 1000;
							await bot.sendReturnMessages(postReturnMsg);
							logger.info(
								`[Canais] Post ${msgId} encaminhado para grupo ${grp.group_id} (${grp.apelido})`
							);
						}
					} catch (forwardErr) {
						logger.error(
							`[Canais] Erro ao encaminhar post ${msgId} para grupo ${grp.group_id}:`,
							forwardErr
						);
					}
				}
			}
		} catch (fwdErr) {
			logger.error("[Canais] Erro no fluxo de encaminhamento:", fwdErr);
		}

		return true;
	} catch (error) {
		logger.error("[Canais] Erro ao detectar postagem de canal:", error);
		return false;
	}
}

/**
 * Constrói array de ReturnMessage estruturadas com a regra de agrupamento de canal-ver:
 * - Se < 4 posts: mensagens separadas
 * - Se 4 a 10 posts: agrupa a cada 3 com '------------'
 * - Se > 10 posts: agrupa a cada 10
 */
async function buildGroupedReturnMessages(
	bot,
	chatId,
	posts,
	apelido,
	diaFormatado,
	canalJid = null,
	allowedTypes = null
) {
	const total = posts.length;
	const returnMessages = [];

	if (total === 0) {
		let extraTip = "";
		if (canalJid) {
			try {
				let dateQuery = "SELECT dia, COUNT(*) as qtd FROM canal_posts WHERE canal_jid = ?";
				const dateParams = [canalJid];
				if (Array.isArray(allowedTypes) && allowedTypes.length > 0) {
					const placeholders = allowedTypes.map(() => "?").join(", ");
					dateQuery += ` AND tipo IN (${placeholders})`;
					dateParams.push(...allowedTypes);
				}
				dateQuery += " GROUP BY dia ORDER BY dia DESC";
				const datasDisponiveis = await database.dbAll(DB_NAME, dateQuery, dateParams);

				if (datasDisponiveis && datasDisponiveis.length > 0) {
					const listaDatas = datasDisponiveis
						.map((d) => {
							const [ano, mes, dia] = d.dia.split("-");
							const plural = d.qtd === 1 ? "postagem" : "postagens";
							return `• *${dia}/${mes}/${ano}* — ${d.qtd} ${plural}`;
						})
						.join("\n");

					const [recAno, recMes, recDia] = datasDisponiveis[0].dia.split("-");
					extraTip = `\n\n📅 *Datas com postagens disponíveis:*\n${listaDatas}\n\n💡 _Para ver: \`!canal-ver ${apelido} ${recDia}/${recMes}\` ou \`!canal-rnd ${apelido}\`_`;
				}
			} catch (e) {
				// ignore
			}
		}

		return [
			new ReturnMessage({
				chatId,
				content: `📭 Nenhuma postagem encontrada para o canal *${apelido}* na data *${diaFormatado}*.${extraTip}`
			})
		];
	}

	// Regra de tamanho de bloco
	let blockSize = 1;
	if (total >= 4 && total <= 10) {
		blockSize = 3;
	} else if (total > 10) {
		blockSize = 10;
	}

	// Divide em blocos
	const blocks = [];
	for (let i = 0; i < total; i += blockSize) {
		blocks.push(posts.slice(i, i + blockSize));
	}

	const separator = "\n------------\n";

	for (let bIndex = 0; bIndex < blocks.length; bIndex++) {
		const block = blocks[bIndex];

		// Se o bloco tiver tamanho 1 (menos de 4 postagens no dia todo)
		if (blockSize === 1) {
			const post = block[0];
			const postMsg = await createPostReturnMessage(bot, chatId, post, apelido);
			if (postMsg) returnMessages.push(postMsg);
			continue;
		}

		// Para blocos agrupados (3 em 3 ou 10 em 10):
		// Agrupa textos contíguos em uma mensagem. Mídias seguem separadas com legenda.
		let currentTextParts = [];

		const flushCurrentText = () => {
			if (currentTextParts.length > 0) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: currentTextParts.join(separator)
					})
				);
				currentTextParts = [];
			}
		};

		for (const post of block) {
			if (post.tipo === "texto" || (!post.arquivo && post.texto)) {
				const horaStr = post.ts
					? new Date(post.ts).toLocaleTimeString("pt-BR", {
							timeZone: "America/Sao_Paulo",
							hour: "2-digit",
							minute: "2-digit"
						})
					: "";
				const header = horaStr ? `🕒 *[${horaStr}]* ` : "";
				currentTextParts.push(`${header}${post.texto || ""}`);
			} else {
				// Houve mídia: descarrega o texto acumulado antes
				flushCurrentText();
				const mediaMsg = await createPostReturnMessage(bot, chatId, post, apelido);
				if (mediaMsg) returnMessages.push(mediaMsg);
			}
		}

		flushCurrentText();

		// Separador entre blocos (exceto após o último bloco)
		if (bIndex < blocks.length - 1) {
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: "------------"
				})
			);
		}
	}

	return returnMessages;
}

/**
 * Cria um ReturnMessage individual para uma postagem (texto ou mídia)
 */
async function createPostReturnMessage(bot, chatId, post, apelido, isForward = false) {
	const horaStr = post.ts
		? new Date(post.ts).toLocaleTimeString("pt-BR", {
				timeZone: "America/Sao_Paulo",
				hour: "2-digit",
				minute: "2-digit"
			})
		: "";
	const header = horaStr ? `🕒 *[${horaStr}]* ` : "";
	const prefix = isForward ? `📢 *${apelido}*\n` : "";
	const captionText = `${prefix}${header}${post.texto || ""}`.trim();

	// Se não tem arquivo, envia como texto
	if (!post.arquivo) {
		return new ReturnMessage({
			chatId,
			content: captionText || `📢 *${apelido}*`
		});
	}

	const absPath = path.isAbsolute(post.arquivo)
		? post.arquivo
		: path.join(__dirname, "../..", post.arquivo);

	if (!fs.existsSync(absPath)) {
		// Arquivo não está no disco, envia como texto
		return new ReturnMessage({
			chatId,
			content: `${captionText}\n_(Mídia não disponível no disco)_`.trim()
		});
	}

	try {
		if (typeof bot?.createMedia === "function") {
			const mediaObj = await bot.createMedia(absPath, post.mimetype);
			if (post.tipo === "sticker") {
				return new ReturnMessage({
					chatId,
					content: mediaObj,
					options: {
						sendMediaAsSticker: true
					}
				});
			} else if (post.tipo === "audio") {
				return new ReturnMessage({
					chatId,
					content: mediaObj,
					options: {
						sendAudioAsVoice: true
					}
				});
			} else {
				return new ReturnMessage({
					chatId,
					content: mediaObj,
					options: {
						caption: captionText || (isForward ? `📢 *${apelido}*` : "")
					}
				});
			}
		} else {
			// Fallback para texto se o bot não suportar createMedia
			return new ReturnMessage({
				chatId,
				content: captionText || `📢 *${apelido}*`
			});
		}
	} catch (err) {
		logger.error(`[Canais] Erro ao anexar mídia para post ${post.msg_id}:`, err);
		return new ReturnMessage({
			chatId,
			content: captionText || `📢 *${apelido}*`
		});
	}
}

// -------------------------------------------------------------
// IMPLEMENTAÇÃO DOS COMANDOS
// -------------------------------------------------------------

/**
 * !canal-seguir <nome> <link>
 */
async function seguirCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de grupos."
		});
	}

	const rawInput = args.join(" ").trim();
	if (!rawInput) {
		return new ReturnMessage({
			chatId,
			content:
				"ℹ️ *Como usar:* `!canal-seguir <nome> <link>`\n\n*Exemplo:*\n`!canal-seguir Carros https://whatsapp.com/channel/0029VbANSmKEgGfFVs1NtU0I`"
		});
	}

	const parsed = parseNameAndLink(rawInput);
	if (parsed.error) {
		return new ReturnMessage({ chatId, content: parsed.error });
	}

	const { link, rawName } = parsed;

	// Verifica o limite de canais no grupo
	const totalCanaisGrupo = await database.dbGet(
		DB_NAME,
		"SELECT COUNT(*) as count FROM canal_grupos WHERE group_id = ?",
		[message.group]
	);

	if (totalCanaisGrupo && totalCanaisGrupo.count >= MAX_CANAIS_POR_GRUPO) {
		return new ReturnMessage({
			chatId,
			content: `❌ Este grupo já atingiu o limite máximo de *${MAX_CANAIS_POR_GRUPO}* canais seguidos!\nUse \`!canal-lista\` para ver os canais ativos ou \`!canal-del <nome>\` para remover algum.`
		});
	}

	// Resolve o link via whatsgoapi
	let metadata = null;
	try {
		const linkRes = await bot.apiClient.post("/newsletter/link", { key: link });
		metadata = linkRes?.data || linkRes;
	} catch (e) {
		logger.error("Erro ao resolver link do canal:", e);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao consultar o canal no WhatsApp: ${e.message || "Link inválido ou canal não encontrado."}`
		});
	}

	const canalJid = metadata?.id;
	if (!canalJid) {
		return new ReturnMessage({
			chatId,
			content: "❌ Não foi possível obter o ID do canal a partir do link informado."
		});
	}

	const nomeOficial = metadata?.thread_metadata?.name?.text || "Canal sem nome";
	const descricao = metadata?.thread_metadata?.description?.text || "";
	const inviteCode = metadata?.thread_metadata?.invite || "";
	const apelidoFinal = (rawName || nomeOficial).trim();
	const apelidoNorm = normalizeString(apelidoFinal);

	if (apelidoNorm.length < 2 || apelidoNorm.length > 40) {
		return new ReturnMessage({
			chatId,
			content: "❌ O nome do canal deve ter entre 2 e 40 caracteres."
		});
	}

	// Verifica se o canal já é seguido neste grupo
	const canalJaExisteNoGrupo = await database.dbGet(
		DB_NAME,
		"SELECT apelido FROM canal_grupos WHERE group_id = ? AND canal_jid = ?",
		[message.group, canalJid]
	);
	if (canalJaExisteNoGrupo) {
		return new ReturnMessage({
			chatId,
			content: `⚠️ Este canal já está sendo seguido neste grupo com o apelido *${canalJaExisteNoGrupo.apelido}*.`
		});
	}

	// Verifica se o apelido já está em uso por outro canal no grupo
	const apelidoEmUso = await database.dbGet(
		DB_NAME,
		"SELECT 1 FROM canal_grupos WHERE group_id = ? AND apelido_normalizado = ?",
		[message.group, apelidoNorm]
	);
	if (apelidoEmUso) {
		return new ReturnMessage({
			chatId,
			content: `❌ O apelido *${apelidoFinal}* já está sendo utilizado por outro canal neste grupo. Escolha um nome diferente.`
		});
	}

	// Salva na tabela geral de canais
	const agora = Date.now();
	await database.dbRun(
		DB_NAME,
		`INSERT INTO canais (jid, invite, link, nome_oficial, descricao, criado_em)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       link = excluded.link,
       nome_oficial = excluded.nome_oficial,
       descricao = excluded.descricao`,
		[canalJid, inviteCode, link, nomeOficial, descricao, agora]
	);

	// Salva o vínculo do grupo
	await database.dbRun(
		DB_NAME,
		`INSERT INTO canal_grupos (group_id, canal_jid, apelido, apelido_normalizado, tipos_midia, criado_por, criado_em)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
		[message.group, canalJid, apelidoFinal, apelidoNorm, message.author, agora]
	);

	// Atualiza cache em memória
	await refreshTrackedChannelsCache();

	// Segue o canal na conta WhatsApp via whatsgoapi
	try {
		await bot.apiClient.post("/newsletter/follow", { jid: canalJid });
		logger.info(`[Canais] Instância ${bot.instanceName} seguiu o canal ${canalJid}`);
	} catch (followErr) {
		logger.warn(
			`[Canais] Aviso ao tentar dar follow no canal ${canalJid}: ${followErr.message || followErr}`
		);
	}

	// Executa backfill das últimas 30 mensagens em segundo plano
	backfillRecentMessages(bot, canalJid, null).catch((err) => {
		logger.error(`[Canais] Erro em segundo plano no backfill de ${canalJid}:`, err);
	});

	const responseText = `✅ Canal *${nomeOficial}* cadastrado com sucesso!
🏷️ Apelido no grupo: *${apelidoFinal}*
📥 Baixando até ${BACKFILL_COUNT} mensagens recentes em segundo plano...

📌 *Comandos que você pode usar:*
• \`!canal-ver ${apelidoFinal} [data]\` — Ver as postagens do dia
• \`!canal-rnd ${apelidoFinal} [tipos]\` — Postagem aleatória
• \`!canal-encaminhar ${apelidoFinal}\` — Ativar/desativar encaminhamento automático
• \`!canal-midias ${apelidoFinal} <tipos>\` — Definir mídias capturadas
• \`!canal-lista\` — Listar canais do grupo
• \`!canal-del ${apelidoFinal}\` — Deixar de seguir

💡 *Dica de Alias:*
Crie um atalho rápido no grupo para este canal:
\`!g-addCmd ${apelidoNorm} {cmd-canal-rnd ${apelidoFinal}}\`
Depois é só digitar \`!${apelidoNorm}\` para receber um post aleatório!`;

	return new ReturnMessage({
		chatId,
		content: responseText
	});
}

/**
 * !canal-lista
 */
async function listaCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de grupos."
		});
	}

	const rows = await database.dbAll(
		DB_NAME,
		`SELECT g.apelido, g.tipos_midia, g.encaminhar, c.nome_oficial, c.link, c.jid,
            (SELECT COUNT(*) FROM canal_posts p WHERE p.canal_jid = g.canal_jid) as total_posts
     FROM canal_grupos g
     JOIN canais c ON g.canal_jid = c.jid
     WHERE g.group_id = ?
     ORDER BY g.criado_em ASC`,
		[message.group]
	);

	if (!rows || rows.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"📭 Nenhum canal está sendo seguido neste grupo.\n\nPara seguir um canal, use:\n`!canal-seguir <nome> <link>`"
		});
	}

	let text = `📢 *Canais seguidos neste grupo (${rows.length}/${MAX_CANAIS_POR_GRUPO}):*\n\n`;

	rows.forEach((row, i) => {
		let midiasStr = "Todas";
		if (row.tipos_midia) {
			try {
				const arr = JSON.parse(row.tipos_midia);
				if (Array.isArray(arr) && arr.length > 0) {
					midiasStr = arr.join(", ");
				}
			} catch (e) {
				midiasStr = "Todas";
			}
		}

		text += `*${i + 1}. ${row.apelido}*\n`;
		if (row.nome_oficial && row.nome_oficial !== row.apelido) {
			text += `   ↳ Oficial: _${row.nome_oficial}_\n`;
		}
		text += `   ↳ Link: ${row.link}\n`;
		text += `   ↳ Mídias: ${midiasStr}\n`;
		text += `   ↳ Postagens salvas: ${row.total_posts}\n`;
		if (row.encaminhar === 1) {
			text += `   ↳ ⏩ *Encaminhando mensagens*\n`;
		}
		text += "\n";
	});

	text += `💡 _Para ver postagens: \`!canal-ver <nome> [data]\`_`;

	return new ReturnMessage({ chatId, content: text.trim() });
}

/**
 * !canal-del <nome>
 */
async function delCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de grupos."
		});
	}

	const targetName = args.join(" ").trim();
	if (!targetName) {
		return new ReturnMessage({
			chatId,
			content:
				"ℹ️ *Como usar:* `!canal-del <nome>`\n\nExemplo: `!canal-del Carros`\nUse `!canal-lista` para ver os nomes."
		});
	}

	const apelidoNorm = normalizeString(targetName);

	const row = await database.dbGet(
		DB_NAME,
		"SELECT canal_jid, apelido FROM canal_grupos WHERE group_id = ? AND apelido_normalizado = ?",
		[message.group, apelidoNorm]
	);

	if (!row) {
		return new ReturnMessage({
			chatId,
			content: `❌ Canal *${targetName}* não encontrado neste grupo. Use \`!canal-lista\` para conferir.`
		});
	}

	// Remove vínculo do grupo
	await database.dbRun(
		DB_NAME,
		"DELETE FROM canal_grupos WHERE group_id = ? AND apelido_normalizado = ?",
		[message.group, apelidoNorm]
	);

	await refreshTrackedChannelsCache();

	// Verifica se algum outro grupo ainda segue esse canal
	const remaining = await database.dbGet(
		DB_NAME,
		"SELECT COUNT(*) as count FROM canal_grupos WHERE canal_jid = ?",
		[row.canal_jid]
	);

	if (!remaining || remaining.count === 0) {
		// Ninguém mais segue: dá unfollow no WhatsApp
		try {
			await bot.apiClient.post("/newsletter/unfollow", { jid: row.canal_jid });
			logger.info(`[Canais] Instância ${bot.instanceName} deu unfollow no canal ${row.canal_jid}`);
		} catch (unfErr) {
			logger.warn(
				`[Canais] Aviso ao dar unfollow em ${row.canal_jid}: ${unfErr.message || unfErr}`
			);
		}
	}

	return new ReturnMessage({
		chatId,
		content: `✅ O canal *${row.apelido}* deixou de ser seguido neste grupo.\n_(As mídias já salvas foram preservadas no banco de dados)._`
	});
}

/**
 * !canal-encaminhar <nome>
 */
async function encaminharCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de grupos."
		});
	}

	const targetName = args.join(" ").trim();
	if (!targetName) {
		return new ReturnMessage({
			chatId,
			content:
				"ℹ️ *Como usar:* `!canal-encaminhar <nome>`\n\nAtiva ou desativa o encaminhamento automático de novas mensagens do canal para este grupo em tempo real.\nUse `!canal-lista` para ver os canais ativos."
		});
	}

	const apelidoNorm = normalizeString(targetName);

	const row = await database.dbGet(
		DB_NAME,
		"SELECT canal_jid, apelido, encaminhar FROM canal_grupos WHERE group_id = ? AND apelido_normalizado = ?",
		[message.group, apelidoNorm]
	);

	if (!row) {
		return new ReturnMessage({
			chatId,
			content: `❌ Canal *${targetName}* não encontrado neste grupo. Use \`!canal-lista\` para conferir.`
		});
	}

	const novoStatus = row.encaminhar === 1 ? 0 : 1;

	await database.dbRun(
		DB_NAME,
		"UPDATE canal_grupos SET encaminhar = ? WHERE group_id = ? AND canal_jid = ?",
		[novoStatus, message.group, row.canal_jid]
	);

	await refreshTrackedChannelsCache();

	if (novoStatus === 1) {
		return new ReturnMessage({
			chatId,
			content: `⏩ *Encaminhamento ativado!* As novas postagens do canal *${row.apelido}* serão encaminhadas automaticamente para este grupo em tempo real.\n\n_Para desativar, use novamente:_ \`!canal-encaminhar ${row.apelido}\``
		});
	} else {
		return new ReturnMessage({
			chatId,
			content: `⏹️ *Encaminhamento desativado.* As postagens do canal *${row.apelido}* não serão mais enviadas automaticamente para este grupo.`
		});
	}
}

/**
 * !canal-ver <nome> [data]
 */
async function verCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de grupos."
		});
	}

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"ℹ️ *Como usar:* `!canal-ver <nome> [data]`\n\n*Exemplos:*\n• `!canal-ver Carros` (postagens de hoje)\n• `!canal-ver Carros ontem`\n• `!canal-ver Carros 19/04/2025`"
		});
	}

	// Procura o canal no grupo casando o prefixo dos argumentos
	const canaisDoGrupo = await database.dbAll(
		DB_NAME,
		"SELECT canal_jid, apelido, apelido_normalizado, tipos_midia FROM canal_grupos WHERE group_id = ?",
		[message.group]
	);

	if (!canaisDoGrupo || canaisDoGrupo.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"📭 Nenhum canal está sendo seguido neste grupo.\nUse `!canal-seguir <nome> <link>` para começar."
		});
	}

	const fullText = args.join(" ").trim();
	const fullNorm = normalizeString(fullText);

	let matchedCanal = null;
	let dateStrArg = null;

	// Encontra o apelido que melhor casa com o início do texto
	// Ordena por comprimento decrescente para casar nomes maiores primeiro (ex: "carros antigos" antes de "carros")
	canaisDoGrupo.sort((a, b) => b.apelido_normalizado.length - a.apelido_normalizado.length);

	for (const c of canaisDoGrupo) {
		if (fullNorm === c.apelido_normalizado || fullNorm.startsWith(`${c.apelido_normalizado} `)) {
			matchedCanal = c;
			const remainder = fullText.substring(c.apelido.length).trim();
			dateStrArg = remainder || null;
			break;
		}
	}

	// Se não casou exatamente com o início, tenta pelo primeiro argumento
	if (!matchedCanal) {
		const firstArgNorm = normalizeString(args[0]);
		matchedCanal = canaisDoGrupo.find((c) => c.apelido_normalizado === firstArgNorm);
		if (matchedCanal) {
			dateStrArg = args.slice(1).join(" ").trim() || null;
		}
	}

	if (!matchedCanal) {
		const nomesDisponiveis = canaisDoGrupo.map((c) => `*${c.apelido}*`).join(", ");
		return new ReturnMessage({
			chatId,
			content: `❌ Canal não encontrado neste grupo.\nCanais disponíveis: ${nomesDisponiveis}`
		});
	}

	// Parse da data
	const targetDia = parseDateInput(dateStrArg);
	if (!targetDia) {
		return new ReturnMessage({
			chatId,
			content: `❌ Formato de data não reconhecido: *${dateStrArg}*.\nUse formatos como "hoje", "ontem", "19/04/2025" ou "YYYY-MM-DD".`
		});
	}

	// Tipos de mídias permitidos pelo grupo
	let allowedTypes = null;
	if (matchedCanal.tipos_midia) {
		try {
			allowedTypes = JSON.parse(matchedCanal.tipos_midia);
		} catch (e) {
			allowedTypes = null;
		}
	}

	// Busca posts do dia
	let query = "SELECT * FROM canal_posts WHERE canal_jid = ? AND dia = ?";
	const params = [matchedCanal.canal_jid, targetDia];

	if (Array.isArray(allowedTypes) && allowedTypes.length > 0) {
		const placeholders = allowedTypes.map(() => "?").join(", ");
		query += ` AND tipo IN (${placeholders})`;
		params.push(...allowedTypes);
	}

	query += " ORDER BY ts ASC, msg_id ASC";

	const posts = await database.dbAll(DB_NAME, query, params);

	const [ano, mes, dia] = targetDia.split("-");
	const diaFormatado = `${dia}/${mes}/${ano}`;

	return await buildGroupedReturnMessages(
		bot,
		chatId,
		posts,
		matchedCanal.apelido,
		diaFormatado,
		matchedCanal.canal_jid,
		allowedTypes
	);
}

/**
 * !canal-midias <nome> [texto,imagem,audio,sticker,video,documento]
 */
async function midiasCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de grupos."
		});
	}

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"ℹ️ *Como usar:* `!canal-midias <nome> [tipos]`\n\n*Exemplos:*\n• `!canal-midias Carros texto, imagem, audio`\n• `!canal-midias Carros` (ativa captura de todos os tipos)"
		});
	}

	const canaisDoGrupo = await database.dbAll(
		DB_NAME,
		"SELECT canal_jid, apelido, apelido_normalizado, tipos_midia FROM canal_grupos WHERE group_id = ?",
		[message.group]
	);

	if (!canaisDoGrupo || canaisDoGrupo.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"📭 Nenhum canal está sendo seguido neste grupo.\nUse `!canal-seguir <nome> <link>` para começar."
		});
	}

	const fullText = args.join(" ").trim();
	const fullNorm = normalizeString(fullText);

	canaisDoGrupo.sort((a, b) => b.apelido_normalizado.length - a.apelido_normalizado.length);

	let matchedCanal = null;
	let typesRawArg = null;

	for (const c of canaisDoGrupo) {
		if (fullNorm === c.apelido_normalizado || fullNorm.startsWith(`${c.apelido_normalizado} `)) {
			matchedCanal = c;
			const remainder = fullText.substring(c.apelido.length).trim();
			typesRawArg = remainder || null;
			break;
		}
	}

	if (!matchedCanal) {
		const firstArgNorm = normalizeString(args[0]);
		matchedCanal = canaisDoGrupo.find((c) => c.apelido_normalizado === firstArgNorm);
		if (matchedCanal) {
			typesRawArg = args.slice(1).join(" ").trim() || null;
		}
	}

	if (!matchedCanal) {
		const nomes = canaisDoGrupo.map((c) => `*${c.apelido}*`).join(", ");
		return new ReturnMessage({
			chatId,
			content: `❌ Canal não encontrado neste grupo.\nCanais disponíveis: ${nomes}`
		});
	}

	// Sem tipos: ativa todos
	if (!typesRawArg) {
		await database.dbRun(
			DB_NAME,
			"UPDATE canal_grupos SET tipos_midia = NULL WHERE group_id = ? AND canal_jid = ?",
			[message.group, matchedCanal.canal_jid]
		);
		await refreshTrackedChannelsCache();

		return new ReturnMessage({
			chatId,
			content: `✅ Captura de *todos os tipos de mídia* ativada para o canal *${matchedCanal.apelido}*!\n\n💡 *Dica:* Para restringir apenas a mídias específicas, envie a lista separada por vírgula:\n\`!canal-midias ${matchedCanal.apelido} texto, imagem, audio\``
		});
	}

	const parsed = parseMediaTypes(typesRawArg);
	if (parsed === null) {
		// "todas" ou "all"
		await database.dbRun(
			DB_NAME,
			"UPDATE canal_grupos SET tipos_midia = NULL WHERE group_id = ? AND canal_jid = ?",
			[message.group, matchedCanal.canal_jid]
		);
		await refreshTrackedChannelsCache();

		return new ReturnMessage({
			chatId,
			content: `✅ Captura de *todas as mídias* ativada para o canal *${matchedCanal.apelido}*!`
		});
	}

	if (parsed.valid === false) {
		return new ReturnMessage({ chatId, content: parsed.error });
	}

	const jsonTypes = JSON.stringify(parsed.types);
	await database.dbRun(
		DB_NAME,
		"UPDATE canal_grupos SET tipos_midia = ? WHERE group_id = ? AND canal_jid = ?",
		[jsonTypes, message.group, matchedCanal.canal_jid]
	);
	await refreshTrackedChannelsCache();

	return new ReturnMessage({
		chatId,
		content: `✅ Tipos de mídia para *${matchedCanal.apelido}* atualizados com sucesso!\n📌 Mídias ativas: *${parsed.types.join(", ")}*`
	});
}

/**
 * !canal-rnd <nome> [tipos]
 */
async function rndCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de grupos."
		});
	}

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"ℹ️ *Como usar:* `!canal-rnd <nome> [tipos]`\n\n*Exemplos:*\n• `!canal-rnd Carros`\n• `!canal-rnd Carros audio,imagem`"
		});
	}

	const canaisDoGrupo = await database.dbAll(
		DB_NAME,
		"SELECT canal_jid, apelido, apelido_normalizado, tipos_midia FROM canal_grupos WHERE group_id = ?",
		[message.group]
	);

	if (!canaisDoGrupo || canaisDoGrupo.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"📭 Nenhum canal está sendo seguido neste grupo.\nUse `!canal-seguir <nome> <link>` para começar."
		});
	}

	const fullText = args.join(" ").trim();
	const fullNorm = normalizeString(fullText);

	canaisDoGrupo.sort((a, b) => b.apelido_normalizado.length - a.apelido_normalizado.length);

	let matchedCanal = null;
	let typesRawArg = null;

	for (const c of canaisDoGrupo) {
		if (fullNorm === c.apelido_normalizado || fullNorm.startsWith(`${c.apelido_normalizado} `)) {
			matchedCanal = c;
			const remainder = fullText.substring(c.apelido.length).trim();
			typesRawArg = remainder || null;
			break;
		}
	}

	if (!matchedCanal) {
		const firstArgNorm = normalizeString(args[0]);
		matchedCanal = canaisDoGrupo.find((c) => c.apelido_normalizado === firstArgNorm);
		if (matchedCanal) {
			typesRawArg = args.slice(1).join(" ").trim() || null;
		}
	}

	if (!matchedCanal) {
		const nomes = canaisDoGrupo.map((c) => `*${c.apelido}*`).join(", ");
		return new ReturnMessage({
			chatId,
			content: `❌ Canal não encontrado neste grupo.\nCanais disponíveis: ${nomes}`
		});
	}

	// Filtro de tipos do comando cruzado com o grupo
	let effectiveTypes = null;

	if (typesRawArg) {
		const parsedCmd = parseMediaTypes(typesRawArg);
		if (parsedCmd && parsedCmd.valid === false) {
			return new ReturnMessage({ chatId, content: parsedCmd.error });
		}
		if (parsedCmd && parsedCmd.types) {
			effectiveTypes = parsedCmd.types;
		}
	}

	if (!effectiveTypes && matchedCanal.tipos_midia) {
		try {
			effectiveTypes = JSON.parse(matchedCanal.tipos_midia);
		} catch (e) {
			effectiveTypes = null;
		}
	}

	let query = "SELECT * FROM canal_posts WHERE canal_jid = ?";
	const params = [matchedCanal.canal_jid];

	if (Array.isArray(effectiveTypes) && effectiveTypes.length > 0) {
		const placeholders = effectiveTypes.map(() => "?").join(", ");
		query += ` AND tipo IN (${placeholders})`;
		params.push(...effectiveTypes);
	}

	query += " ORDER BY RANDOM() LIMIT 1";

	const post = await database.dbGet(DB_NAME, query, params);

	if (!post) {
		return new ReturnMessage({
			chatId,
			content: `📭 Nenhuma postagem encontrada para o canal *${matchedCanal.apelido}* com os filtros aplicados.`
		});
	}

	return await createPostReturnMessage(bot, chatId, post, matchedCanal.apelido);
}

// -------------------------------------------------------------
// DEFINIÇÃO DOS COMANDOS EXPORTADOS
// -------------------------------------------------------------

const commands = [
	new Command({
		name: "canal-seguir",
		aliases: ["seguir-canal", "canalseguir"],
		description: "Cadastra um canal do WhatsApp para seguir neste grupo",
		usage: "!canal-seguir <nome> <link>",
		category: "canais",
		adminOnly: true,
		caseSensitive: false,
		timeout: 120,
		method: seguirCommand
	}),
	new Command({
		name: "canal-lista",
		aliases: ["canais", "canais-lista", "lista-canais"],
		description: "Lista os canais do WhatsApp seguidos neste grupo",
		usage: "!canal-lista",
		category: "canais",
		adminOnly: false,
		caseSensitive: false,
		timeout: 30,
		method: listaCommand
	}),
	new Command({
		name: "canal-del",
		aliases: ["canal-remover", "remover-canal", "canaldel"],
		description: "Para de seguir um canal do WhatsApp neste grupo",
		usage: "!canal-del <nome>",
		category: "canais",
		adminOnly: true,
		caseSensitive: false,
		timeout: 30,
		method: delCommand
	}),
	new Command({
		name: "canal-ver",
		aliases: ["canalver"],
		description: "Exibe as postagens do dia de um canal seguido no grupo",
		usage: "!canal-ver <nome> [data]",
		category: "canais",
		adminOnly: false,
		caseSensitive: false,
		timeout: 120,
		method: verCommand
	}),
	new Command({
		name: "canal-midias",
		aliases: ["canal-midia", "canalmidias"],
		description: "Configura quais tipos de mídias serão capturados do canal",
		usage: "!canal-midias <nome> [texto,imagem,audio,sticker,video,documento]",
		category: "canais",
		adminOnly: true,
		caseSensitive: false,
		timeout: 30,
		method: midiasCommand
	}),
	new Command({
		name: "canal-rnd",
		aliases: ["canal-random", "canalrnd"],
		description: "Envia uma postagem aleatória de um canal seguido",
		usage: "!canal-rnd <nome> [tipos]",
		category: "canais",
		adminOnly: false,
		caseSensitive: false,
		timeout: 60,
		method: rndCommand
	}),
	new Command({
		name: "canal-encaminhar",
		aliases: ["canalencaminhar", "encaminhar-canal"],
		description:
			"Ativa ou desativa o encaminhamento de mensagens do canal para o grupo em tempo real",
		usage: "!canal-encaminhar <nome>",
		category: "canais",
		adminOnly: true,
		caseSensitive: false,
		timeout: 30,
		method: encaminharCommand
	})
];

module.exports = {
	commands,
	detectPost,
	parseNameAndLink,
	parseMediaTypes,
	parseDateInput,
	buildGroupedReturnMessages,
	classifyMessageType,
	refreshTrackedChannelsCache,
	MAX_CANAIS_POR_GRUPO
};
