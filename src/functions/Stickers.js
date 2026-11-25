const path = require("path");
const Logger = require("../utils/Logger");
const fs = require("fs").promises;
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");

const CmdUsage = require("../utils/CmdUsage");
const LLMService = require("../services/LLMService");
const telemetry = require("../telemetry");

const logger = new Logger("sticker-commands");
const database = Database.getInstance();
const cmdUsage = CmdUsage.getInstance();
const TEMP_DIR = path.join(__dirname, "../../temp", "whatsapp-bot-stickers");
//logger.info('Módulo  Commands carregado');

// Parte dos quadrados
// Garantir que o diretório temporário exista
async function ensureTempDir() {
	try {
		await fs.mkdir(TEMP_DIR, { recursive: true });
	} catch (error) {
		logger.error("Erro ao criar diretório temporário:", error);
	}
}

// Limpar arquivos temporários mais antigos que 1 hora
async function cleanupTempFiles() {
	try {
		const files = await fs.readdir(TEMP_DIR);
		const now = Date.now();
		const oneHourAgo = now - 60 * 60 * 1000;

		for (const file of files) {
			const filePath = path.join(TEMP_DIR, file);
			const stats = await fs.stat(filePath);

			if (stats.mtimeMs < oneHourAgo) {
				await fs.unlink(filePath);
			}
		}
	} catch (error) {
		logger.error("Erro ao limpar arquivos temporários:", error);
	}
}

// Padrões recomendados do WhatsApp/whatsmeow para figurinhas (stickers)
const WHATSAPP_STICKER = {
	MAX_SIZE: 512, // Dimensão padrão do WhatsApp: 512x512 pixels
	MAX_DURATION: 18, // Duração máxima padrão de até 18s
	// whatsmeow não impõe corte de duração no protobuf StickerMessage, mas clientes WhatsApp
	// exigem < 500 KB por sticker; 60s é o teto prático antes de degradar FPS/resolução demais.
	MAX_LONG_DURATION: 60,
	FPS: 12, // 12 FPS padrão para animações mais fluidas
	MAX_FILE_SIZE: 490 * 1024, // Limite de segurança (< 500 KB) do WhatsApp (margem p/ metadados EXIF)
	STATIC_QUALITY: 80, // Qualidade WebP para imagens estáticas
	ANIMATED_QUALITY: 30, // Qualidade inicial para 18s a 12 FPS
	COMPRESSION_LEVEL: 6, // Nível de compressão máximo da libwebp (0-6)
	LONG_COMPRESSION_LEVEL: 4 // Equilíbrio velocidade/compressão em vídeos longos
};

// Perfis sequenciais de fallback para figurinhas animadas (interrompe assim que tamanho <= 490 KB)
const ANIMATED_FALLBACK_PROFILES = [
	{ duration: 18, fps: 12, qv: 30, desc: "18s @ 12fps (q:30)" },
	{ duration: 15, fps: 12, qv: 24, desc: "15s @ 12fps (q:24)" },
	{ duration: 15, fps: 10, qv: 20, desc: "15s @ 10fps menor q:v (q:20)" },
	{ duration: 10, fps: 10, qv: 22, desc: "10s @ 10fps (q:22)" },
	{ duration: 6, fps: 12, qv: 24, desc: "6s @ 12fps (q:24)" },
	{ duration: 3.5, fps: 10, qv: 20, desc: "3.5s @ 10fps (q:20)" }
];

// Perfis sequenciais de fallback para figurinhas animadas em alta taxa de quadros (HQ: 22-25 FPS)
const ANIMATED_HQ_PROFILES = [
	{ duration: 7, fps: 25, qv: 24, desc: "7s @ 25fps (q:24)" },
	{ duration: 6, fps: 25, qv: 18, desc: "6s @ 25fps menor q:v (q:18)" },
	{ duration: 5, fps: 22, qv: 18, desc: "5s @ 22fps (q:18)" },
	{ duration: 4.5, fps: 22, qv: 14, desc: "4.5s @ 22fps (q:14)" }
];

// Tabela de perfis longos (!slongo e !slongohq): preservam duração até MAX_LONG_DURATION,
// reduzindo resolução, FPS e q:v antes de recorrer a cortes de duração como último recurso.
const LONG_PROFILE_TIERS = {
	long: [
		{
			maxUpTo: 22,
			fps: 8,
			maxSize: 512,
			qv: 26,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{
			maxUpTo: 38,
			fps: 8,
			maxSize: 384,
			qv: 20,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{
			maxUpTo: Infinity,
			fps: 6,
			maxSize: 320,
			qv: 18,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{
			maxUpTo: Infinity,
			fps: 5,
			maxSize: 256,
			qv: 16,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{
			maxUpTo: Infinity,
			fps: 4,
			maxSize: 256,
			qv: 14,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{ maxUpTo: Infinity, fps: 3, maxSize: 192, qv: 10, compressionLevel: 5 }
	],
	longhq: [
		{
			maxUpTo: 18,
			fps: 22,
			maxSize: 512,
			qv: 24,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{
			maxUpTo: 26,
			fps: 15,
			maxSize: 512,
			qv: 20,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{
			maxUpTo: 35,
			fps: 14,
			maxSize: 384,
			qv: 18,
			compressionLevel: WHATSAPP_STICKER.LONG_COMPRESSION_LEVEL
		},
		{ maxUpTo: 50, fps: 12, maxSize: 320, qv: 16, compressionLevel: 5 },
		{ maxUpTo: Infinity, fps: 10, maxSize: 256, qv: 14, compressionLevel: 5 },
		{ maxUpTo: Infinity, fps: 8, maxSize: 224, qv: 12, compressionLevel: 5 },
		{ maxUpTo: Infinity, fps: 6, maxSize: 200, qv: 10, compressionLevel: 5 },
		{ maxUpTo: Infinity, fps: 5, maxSize: 192, qv: 10, compressionLevel: 5 }
	]
};

/**
 * Converte duração numérica ou no formato HH:MM:SS(.ms) retornada pelo ffprobe para segundos.
 * @param {string|number|undefined|null} rawValue
 * @returns {number|null}
 */
function parseFfprobeDuration(rawValue) {
	if (typeof rawValue === "number") {
		return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : null;
	}
	if (typeof rawValue !== "string") {
		return null;
	}
	const trimmed = rawValue.trim();
	if (!trimmed || trimmed === "N/A") {
		return null;
	}
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const numeric = parseFloat(trimmed);
		return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
	}
	const hmsMatch = trimmed.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
	if (hmsMatch) {
		const seconds = Number(hmsMatch[1]) * 3600 + Number(hmsMatch[2]) * 60 + parseFloat(hmsMatch[3]);
		return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
	}
	return null;
}

/**
 * Obtém a duração de um arquivo de mídia em segundos via ffprobe, priorizando a trilha de vídeo.
 * @param {string} inputPath
 * @returns {Promise<number|null>}
 */
function getMediaDuration(inputPath) {
	return new Promise((resolve) => {
		ffmpeg.ffprobe(inputPath, (err, metadata) => {
			if (err || !metadata) {
				return resolve(null);
			}
			const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
			const videoDuration = streams
				.filter((s) => s.codec_type === "video")
				.map((s) => parseFfprobeDuration(s.duration) ?? parseFfprobeDuration(s.tags?.DURATION))
				.find((d) => d !== null);
			if (videoDuration !== undefined) {
				return resolve(videoDuration);
			}

			const formatDuration = parseFfprobeDuration(metadata.format?.duration);
			if (formatDuration !== null) {
				return resolve(formatDuration);
			}

			const anyStreamDuration = streams
				.map((s) => parseFfprobeDuration(s.duration) ?? parseFfprobeDuration(s.tags?.DURATION))
				.find((d) => d !== null);
			return resolve(anyStreamDuration ?? null);
		});
	});
}

/**
 * Monta perfis adaptativos para vídeos longos (!slongo / !slongohq) limitados a MAX_LONG_DURATION.
 * @param {"long"|"longhq"} mode
 * @param {number|null} mediaDuration
 * @returns {Array<Object>}
 */
function buildLongAnimatedProfiles(mode, mediaDuration) {
	const hasValidDuration =
		typeof mediaDuration === "number" && Number.isFinite(mediaDuration) && mediaDuration > 0;
	const targetDuration = hasValidDuration
		? Number(Math.max(1, Math.min(mediaDuration, WHATSAPP_STICKER.MAX_LONG_DURATION)).toFixed(2))
		: WHATSAPP_STICKER.MAX_LONG_DURATION;
	// Sem duração conhecida (ex.: WebM sem metadados), inicia dos perfis mais altos porque -t 60 encerra no EOS
	const tierCheckDuration = hasValidDuration ? targetDuration : 1;
	const tiers = LONG_PROFILE_TIERS[mode] || LONG_PROFILE_TIERS.long;

	const selected = tiers
		.filter((t) => tierCheckDuration <= t.maxUpTo)
		.map((t) => ({
			duration: targetDuration,
			fps: t.fps,
			maxSize: t.maxSize,
			qv: t.qv,
			compressionLevel: t.compressionLevel,
			desc: `${targetDuration}s @ ${t.fps}fps (${t.maxSize}px, q:${t.qv})`
		}));

	// Garante fallbacks de corte de duração apenas como último recurso para entropia extrema
	const trimDur1 = Number(Math.min(targetDuration, 35).toFixed(2));
	const trimDur2 = Number(Math.min(targetDuration, 20).toFixed(2));
	const trimDur3 = Number(Math.min(targetDuration, 10).toFixed(2));
	const trimFps = mode === "longhq" ? 6 : 4;
	selected.push(
		{
			duration: trimDur1,
			fps: trimFps,
			maxSize: 224,
			qv: 12,
			compressionLevel: 5,
			desc: `${trimDur1}s @ ${trimFps}fps fallback (224px, q:12)`
		},
		{
			duration: trimDur2,
			fps: trimFps,
			maxSize: 192,
			qv: 10,
			compressionLevel: WHATSAPP_STICKER.COMPRESSION_LEVEL,
			desc: `${trimDur2}s @ ${trimFps}fps mínimo (192px, q:10)`
		},
		{
			duration: trimDur3,
			fps: 3,
			maxSize: 160,
			qv: 8,
			compressionLevel: 6,
			desc: `${trimDur3}s @ 3fps compacto extremo (160px, q:8)`
		}
	);

	return selected;
}

const STICKER_CROP_FLAG_MAP = {
	q: "center",
	c: "center",
	centro: "center",
	center: "center",
	qc: "top",
	cima: "top",
	top: "top",
	topo: "top",
	qb: "bottom",
	baixo: "bottom",
	bottom: "bottom",
	base: "bottom",
	qe: "stretch",
	esticar: "stretch",
	stretch: "stretch",
	qi: "llm",
	ia: "llm",
	llm: "llm"
};

const STICKER_TRANSFORM_FLAG_MAP = {
	fh: "flipH",
	fliph: "flipH",
	hflip: "flipH",
	inv: "flipH",
	invh: "flipH",
	espelhar: "flipH",
	mirror: "flipH",
	fv: "flipV",
	flipv: "flipV",
	vflip: "flipV",
	invv: "flipV",
	90: "rot90",
	"+90": "rot90",
	r90: "rot90",
	g90: "rot90",
	rot90: "rot90",
	horario: "rot90",
	"-90": "rot270",
	270: "rot270",
	"r-90": "rot270",
	r270: "rot270",
	l90: "rot270",
	antihorario: "rot270",
	ah: "rot270"
};

/**
 * Interpreta argumentos combináveis de comandos de figurinha (!s, !sa, !shq, etc.).
 * @param {Array<string>} args
 * @param {Object} [baseOptions={}]
 * @returns {{ cropMode: string, qualityMode: string, transforms: { flipH: boolean, flipV: boolean, rotation: number }, remainingArgs: Array<string>, hasExplicitVisualChanges: boolean }}
 */
function parseStickerArgs(args = [], baseOptions = {}) {
	let explicitCrop = baseOptions.cropMode || null;
	let hq = Boolean(baseOptions.hq);
	let longo = Boolean(baseOptions.longo);
	let flipH = Boolean(baseOptions.transforms?.flipH);
	let flipV = Boolean(baseOptions.transforms?.flipV);
	let rotation = Number(baseOptions.transforms?.rotation || 0) % 360;
	const remainingArgs = [];

	for (const rawArg of Array.isArray(args) ? args : []) {
		const normalized = String(rawArg || "")
			.trim()
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[°º]/g, "");

		if (!normalized) continue;

		if (normalized === "hq") {
			hq = true;
		} else if (normalized === "longo" || normalized === "long") {
			longo = true;
		} else if (STICKER_CROP_FLAG_MAP[normalized]) {
			explicitCrop = STICKER_CROP_FLAG_MAP[normalized];
		} else if (STICKER_TRANSFORM_FLAG_MAP[normalized]) {
			const action = STICKER_TRANSFORM_FLAG_MAP[normalized];
			if (action === "flipH") flipH = !flipH;
			else if (action === "flipV") flipV = !flipV;
			else if (action === "rot90") rotation = (rotation + 90) % 360;
			else if (action === "rot270") rotation = (rotation + 270) % 360;
		} else {
			remainingArgs.push(rawArg);
		}
	}

	let qualityMode = "normal";
	if (hq && longo) qualityMode = "longhq";
	else if (longo) qualityMode = "long";
	else if (hq) qualityMode = "hq";

	const cropMode =
		explicitCrop ||
		(qualityMode === "hq" || qualityMode === "longhq" ? "hq_aspect" : "transparent");

	const hasExplicitVisualChanges = Boolean(
		explicitCrop || hq || longo || flipH || flipV || rotation !== 0
	);

	return {
		cropMode,
		qualityMode,
		transforms: { flipH, flipV, rotation },
		remainingArgs,
		hasExplicitVisualChanges
	};
}

/**
 * Normaliza opções de sticker (aceita string legada de cropType ou objeto completo).
 * @param {string|Object} optionsOrCropType
 * @returns {{ cropMode: string, qualityMode: string, transforms: { flipH: boolean, flipV: boolean, rotation: number } }}
 */
function normalizeStickerOptions(optionsOrCropType) {
	if (optionsOrCropType && typeof optionsOrCropType === "object") {
		return {
			cropMode: optionsOrCropType.cropMode || "transparent",
			qualityMode: optionsOrCropType.qualityMode || "normal",
			transforms: {
				flipH: Boolean(optionsOrCropType.transforms?.flipH),
				flipV: Boolean(optionsOrCropType.transforms?.flipV),
				rotation: Number(optionsOrCropType.transforms?.rotation || 0) % 360
			}
		};
	}

	const raw = String(optionsOrCropType || "transparent");
	if (raw === "hq") {
		return {
			cropMode: "hq_aspect",
			qualityMode: "hq",
			transforms: { flipH: false, flipV: false, rotation: 0 }
		};
	}
	if (raw === "long") {
		return {
			cropMode: "transparent",
			qualityMode: "long",
			transforms: { flipH: false, flipV: false, rotation: 0 }
		};
	}
	if (raw === "longhq") {
		return {
			cropMode: "hq_aspect",
			qualityMode: "longhq",
			transforms: { flipH: false, flipV: false, rotation: 0 }
		};
	}

	return {
		cropMode: raw,
		qualityMode: "normal",
		transforms: { flipH: false, flipV: false, rotation: 0 }
	};
}

/**
 * Monta o filtro FFmpeg para conversão animada conforme cropMode, resolução, FPS e transformações.
 * @param {string|Object} optionsOrCropType
 * @param {number} size
 * @param {number} fps
 * @returns {string}
 */
function buildAnimatedVideoFilter(optionsOrCropType, size, fps) {
	const { cropMode, transforms } = normalizeStickerOptions(optionsOrCropType);
	const filters = [`fps=${fps}`];

	if (transforms.rotation === 90) {
		filters.push("transpose=1");
	} else if (transforms.rotation === 180) {
		filters.push("transpose=1,transpose=1");
	} else if (transforms.rotation === 270) {
		filters.push("transpose=2");
	}
	if (transforms.flipH) {
		filters.push("hflip");
	}
	if (transforms.flipV) {
		filters.push("vflip");
	}

	const percentage = parseFloat(cropMode);
	if (!isNaN(percentage)) {
		filters.push(
			`crop=min(iw\\,ih):min(iw\\,ih):clip((iw*${percentage}/100)-(min(iw\\,ih)/2)\\,0\\,iw-min(iw\\,ih)):clip((ih*${percentage}/100)-(min(iw\\,ih)/2)\\,0\\,ih-min(iw\\,ih))`,
			`scale=${size}:${size}`,
			"format=yuva420p"
		);
	} else if (cropMode === "center") {
		filters.push(
			"crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2",
			`scale=${size}:${size}`,
			"format=yuva420p"
		);
	} else if (cropMode === "top") {
		filters.push(
			"crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:0",
			`scale=${size}:${size}`,
			"format=yuva420p"
		);
	} else if (cropMode === "bottom") {
		filters.push(
			"crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:ih-min(iw\\,ih)",
			`scale=${size}:${size}`,
			"format=yuva420p"
		);
	} else if (cropMode === "stretch") {
		filters.push(`scale=${size}:${size}`, "format=yuva420p");
	} else if (cropMode === "hq_aspect" || cropMode === "hq" || cropMode === "longhq") {
		filters.push(
			`scale=${size}:${size}:force_original_aspect_ratio=decrease`,
			"scale=trunc(iw/2)*2:trunc(ih/2)*2"
		);
	} else {
		// Padrão ("transparent"): ajusta dentro de size x size com bordas 100% transparentes
		filters.push(
			`scale=${size}:${size}:force_original_aspect_ratio=decrease`,
			"format=yuva420p",
			`pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
		);
	}

	return filters.join(",");
}

// Semáforo de concorrência: limita FFmpegs paralelos para evitar contenção de CPU
// Quando todos os slots estão ocupados, novas requisições aguardam na fila
const FFMPEG_MAX_CONCURRENT = 2;
let ffmpegActiveCount = 0;
const ffmpegQueue = [];

function acquireFFmpegSlot() {
	return new Promise((resolve) => {
		if (ffmpegActiveCount < FFMPEG_MAX_CONCURRENT) {
			ffmpegActiveCount++;
			resolve();
		} else {
			// logger.info(
			// 	`[FFmpegSemaphore] Slot ocupado (${ffmpegActiveCount}/${FFMPEG_MAX_CONCURRENT}), aguardando na fila (${ffmpegQueue.length + 1} na fila)...`
			// );
			ffmpegQueue.push(resolve);
		}
	});
}

function releaseFFmpegSlot() {
	if (ffmpegQueue.length > 0) {
		const next = ffmpegQueue.shift();
		// logger.info(
		// 	`[FFmpegSemaphore] Liberando slot para próximo da fila (${ffmpegQueue.length} restantes)`
		// );
		next();
	} else {
		ffmpegActiveCount--;
	}
}

// Função para determinar se o arquivo é um vídeo ou uma imagem
function isVideo(mimeType) {
	return mimeType.startsWith("video/") || mimeType === "image/gif";
}

const MIME_TO_EXTENSION = {
	"image/gif": "gif",
	"image/webp": "webp",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"audio/ogg": "ogg",
	"audio/opus": "opus",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/mp4": "m4a",
	"audio/x-m4a": "m4a",
	"audio/aac": "aac",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac"
};

// Função para salvar o buffer de mídia temporariamente
async function saveTempMedia(mediaBuffer, mimeType, filename = "") {
	await ensureTempDir();

	const cleanMime = String(mimeType || "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	let extension = MIME_TO_EXTENSION[cleanMime];
	if (!extension && filename) {
		const extMatch = String(filename)
			.toLowerCase()
			.match(/\.([a-z0-9]{2,5})$/);
		if (extMatch) extension = extMatch[1];
	}
	if (!extension) {
		if (cleanMime.includes("gif")) extension = "gif";
		else if (cleanMime.includes("webp")) extension = "webp";
		else if (cleanMime.startsWith("audio/")) extension = "audio";
		else extension = "mp4";
	}

	const tempFileName = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${extension}`;
	const tempFilePath = path.join(TEMP_DIR, tempFileName);

	await fs.writeFile(tempFilePath, mediaBuffer);
	return tempFilePath;
}

const DOCUMENT_EXTENSION_MIME_MAP = {
	".png": { kind: "image", mime: "image/png" },
	".jpg": { kind: "image", mime: "image/jpeg" },
	".jpeg": { kind: "image", mime: "image/jpeg" },
	".webp": { kind: "image", mime: "image/webp" },
	".bmp": { kind: "image", mime: "image/bmp" },
	".tif": { kind: "image", mime: "image/tiff" },
	".tiff": { kind: "image", mime: "image/tiff" },
	".avif": { kind: "image", mime: "image/avif" },
	".heic": { kind: "image", mime: "image/heic" },
	".heif": { kind: "image", mime: "image/heif" },
	".gif": { kind: "video", mime: "image/gif" },
	".mp4": { kind: "video", mime: "video/mp4" },
	".mov": { kind: "video", mime: "video/quicktime" },
	".webm": { kind: "video", mime: "video/webm" },
	".mkv": { kind: "video", mime: "video/x-matroska" },
	".avi": { kind: "video", mime: "video/x-msvideo" },
	".m4v": { kind: "video", mime: "video/x-m4v" },
	".3gp": { kind: "video", mime: "video/3gpp" },
	".mp3": { kind: "audio", mime: "audio/mpeg" },
	".ogg": { kind: "audio", mime: "audio/ogg" },
	".oga": { kind: "audio", mime: "audio/ogg" },
	".opus": { kind: "audio", mime: "audio/opus" },
	".m4a": { kind: "audio", mime: "audio/mp4" },
	".aac": { kind: "audio", mime: "audio/aac" },
	".wav": { kind: "audio", mime: "audio/wav" },
	".flac": { kind: "audio", mime: "audio/flac" },
	".amr": { kind: "audio", mime: "audio/amr" },
	".weba": { kind: "audio", mime: "audio/webm" }
};

/**
 * Classifica um anexo do tipo document em audio, video, image ou unsupported.
 * @param {Object} msg
 * @param {Object|null} downloadedMedia
 * @returns {{ kind: "audio"|"video"|"image"|"unsupported", mimeType: string, filename: string }}
 */
function classifyDocumentMedia(msg, downloadedMedia = null) {
	const rawMime = String(
		downloadedMedia?.mimetype ||
			msg?.content?.mimetype ||
			msg?.content?._mediaDetails?.mimetype ||
			""
	)
		.split(";")[0]
		.trim()
		.toLowerCase();
	const filename = String(
		downloadedMedia?.filename ||
			msg?.content?.filename ||
			msg?.content?.title ||
			msg?.content?._mediaDetails?.fileName ||
			""
	).trim();
	const extMatch = filename.toLowerCase().match(/(\.[a-z0-9]{2,5})$/);
	const extEntry = extMatch ? DOCUMENT_EXTENSION_MIME_MAP[extMatch[1]] : null;

	if (rawMime === "image/gif") {
		return { kind: "video", mimeType: "image/gif", filename };
	}
	if (rawMime.startsWith("audio/")) {
		return { kind: "audio", mimeType: rawMime, filename };
	}
	if (rawMime.startsWith("video/")) {
		return { kind: "video", mimeType: rawMime, filename };
	}
	if (rawMime.startsWith("image/")) {
		return { kind: "image", mimeType: rawMime, filename };
	}
	if (extEntry) {
		return { kind: extEntry.kind, mimeType: extEntry.mime, filename };
	}
	return { kind: "unsupported", mimeType: rawMime || "application/octet-stream", filename };
}

/**
 * Executa ffmpeg com múltiplos fallbacks em cascata para figurinhas animadas.
 *
 * @param {string} inputPath - Caminho do vídeo/gif de entrada
 * @param {string|Function} filterCommand - Filtro de vídeo ou função (profile) => filtro
 * @param {Array} [profiles=ANIMATED_FALLBACK_PROFILES] - Perfis sequenciais de fallback
 * @param {string} [cropType="transparent"] - Modo de recorte para telemetria
 * @returns {Promise<Buffer>} - Buffer WebP animado
 */
async function encodeAnimatedWebPWithFallback(
	inputPath,
	filterCommand,
	profiles = ANIMATED_FALLBACK_PROFILES,
	cropType = "transparent"
) {
	await ensureTempDir();

	// Aguarda slot no semáforo antes de abrir o span para não inflar o tempo real de encoding
	const queueStart = Date.now();
	await acquireFFmpegSlot();
	const queueWaitMs = Date.now() - queueStart;

	try {
		return await telemetry.withSpan(
			"sticker encode.animated",
			{
				attributes: {
					"ravena.sticker.crop_type": String(cropType),
					"ravena.sticker.profile_count": profiles.length,
					"ravena.sticker.queue_wait_ms": queueWaitMs
				}
			},
			async (span) => {
				const runFfmpeg = (options, filter, output) =>
					new Promise((resolve, reject) => {
						ffmpeg(inputPath)
							.outputOptions(options)
							.videoFilters(filter)
							.toFormat("webp")
							.save(output)
							.on("end", resolve)
							.on("error", reject);
					});

				let bestBuffer = null;
				let bestSize = Infinity;
				let bestDesc = profiles[0]?.desc || "";
				let attempts = 0;
				const tempFilesToClean = [];

				try {
					for (let i = 0; i < profiles.length; i++) {
						const profile = profiles[i];
						attempts = i + 1;
						const currentOutput = path.join(
							TEMP_DIR,
							`anim-${Date.now()}-${i}-${Math.random().toString(36).substring(7)}.webp`
						);
						tempFilesToClean.push(currentOutput);

						let currentFilter;
						if (typeof filterCommand === "function") {
							currentFilter = filterCommand(profile);
						} else {
							currentFilter = filterCommand.includes("fps=")
								? filterCommand.replace(/fps=\d+/, `fps=${profile.fps}`)
								: `fps=${profile.fps},${filterCommand}`;
						}

						const compressionLevel = profile.compressionLevel ?? WHATSAPP_STICKER.COMPRESSION_LEVEL;

						await runFfmpeg(
							[
								"-y",
								"-t",
								String(profile.duration),
								"-c:v",
								"libwebp",
								"-lossless",
								"0",
								"-compression_level",
								String(compressionLevel),
								"-q:v",
								String(profile.qv),
								"-loop",
								"0",
								"-an"
							],
							currentFilter,
							currentOutput
						);

						const stats = await fs.stat(currentOutput);

						if (stats.size < bestSize) {
							bestSize = stats.size;
							bestDesc = profile.desc || bestDesc;
							bestBuffer = await fs.readFile(currentOutput);
						}

						if (stats.size <= WHATSAPP_STICKER.MAX_FILE_SIZE) {
							telemetry.setAttrs(
								{
									"ravena.sticker.attempts": attempts,
									"ravena.sticker.profile_desc": profile.desc,
									"ravena.sticker.size_bytes": stats.size,
									"ravena.sticker.approved": true
								},
								span
							);
							return bestBuffer;
						}
					}

					telemetry.setAttrs(
						{
							"ravena.sticker.attempts": attempts,
							"ravena.sticker.profile_desc": bestDesc,
							"ravena.sticker.size_bytes": bestSize,
							"ravena.sticker.approved": false
						},
						span
					);
					return bestBuffer;
				} finally {
					await Promise.all(tempFilesToClean.map((file) => fs.unlink(file).catch(() => {})));
				}
			}
		);
	} finally {
		releaseFFmpegSlot();
	}
}

/**
 * Faz uma query LLM para saber qual a melhor coordenada de corte (em porcentagem)
 * @param {Buffer|string} mediaBuffer - Buffer ou base64 da mídia
 * @param {string} mimeType - Tipo MIME da mídia
 * @returns {Promise<number>} - Porcentagem sugerida (0-100)
 */
async function getLLMCropPercentage(mediaBuffer, mimeType) {
	try {
		logger.info("[getLLMCropPercentage] Solicitando sugestão de corte ao LLM");

		// Converter base64 para Buffer se necessário
		let imageBuffer = mediaBuffer;
		if (typeof mediaBuffer === "string") {
			imageBuffer = Buffer.from(mediaBuffer, "base64");
		} else if (mediaBuffer.data && typeof mediaBuffer.data === "string") {
			imageBuffer = Buffer.from(mediaBuffer.data, "base64");
		}

		// Se for vídeo, extrair o primeiro frame para análise do LLM usando sharp
		// Sharp consegue ler o primeiro frame de um buffer de imagem/gif/webp
		const image = sharp(imageBuffer);
		const metadata = await image.metadata();

		const isLandscape = metadata.width > metadata.height;
		const orientation = isLandscape
			? "paisagem (mais larga que alta)"
			: "retrato (mais alta que larga)";
		const dimension = isLandscape ? "horizontal (eixo X)" : "vertical (eixo Y)";
		const startTerm = isLandscape ? "esquerda" : "topo";
		const endTerm = isLandscape ? "direita" : "base";

		const prompt = `Analise esta imagem e identifique a 'área de interesse' (a parte mais relevante, como um rosto ou objeto principal).
A imagem está no formato ${orientation}.
Retorne o centro ${dimension} desta área como uma porcentagem (0 a 100).
0 representa o/a ${startTerm} e 100 representa o/a ${endTerm}.
Responda APENAS com um objeto JSON seguindo este schema: { "percentage": número }`;

		const cropSchema = {
			type: "json_schema",
			json_schema: {
				name: "crop_analysis",
				schema: {
					type: "object",
					properties: {
						percentage: {
							type: "number",
							description: "A coordenada central ideal (0-100) para um corte quadrado"
						},
						reason: {
							type: "string",
							description: "Breve motivo da escolha"
						}
					},
					required: ["percentage"]
				}
			}
		};

		const response = await LLMService.getInstance().getCompletion({
			prompt,
			image: imageBuffer.toString("base64"),
			response_format: cropSchema,
			temperature: 0.2,
			priority: 5,
			systemContext: "Você é um especialista em processamento e análise de imagens."
		});

		try {
			const parsed = JSON.parse(response);
			if (typeof parsed.percentage === "number") {
				logger.info(
					`[getLLMCropPercentage] LLM sugeriu: ${parsed.percentage}% (${parsed.reason || "sem motivo"})`
				);
				return Math.max(0, Math.min(100, parsed.percentage));
			}
		} catch (e) {
			logger.warn(`[getLLMCropPercentage] Erro ao parsear resposta do LLM: ${response}`);
		}

		return 50; // Fallback para o centro
	} catch (error) {
		logger.error("[getLLMCropPercentage] Erro ao obter sugestão do LLM:", error);
		return 50;
	}
}

// Função para converter um buffer de mídia em um buffer de sticker quadrado nos padrões do WhatsApp
async function makeSquareMedia(mediaBuffer, mimeType, optionsOrCropType = "center") {
	const fnStart = Date.now();
	const { cropMode, qualityMode, transforms } = normalizeStickerOptions(optionsOrCropType);
	const isHqQuality = qualityMode === "hq" || qualityMode === "longhq";
	try {
		// Converter de base64 para Buffer se necessário
		let rawBuffer = mediaBuffer;
		if (typeof mediaBuffer === "string") {
			rawBuffer = Buffer.from(mediaBuffer, "base64");
		} else if (mediaBuffer.data && typeof mediaBuffer.data === "string") {
			rawBuffer = Buffer.from(mediaBuffer.data, "base64");
		}

		const TARGET_SIZE = WHATSAPP_STICKER.MAX_SIZE;
		const FPS = WHATSAPP_STICKER.FPS;

		// Verifica se é WebP animado
		let isAnimWebP = false;
		if (mimeType === "image/webp") {
			try {
				const checkAnim = sharp(rawBuffer, { animated: true });
				const meta = await checkAnim.metadata();
				if (meta.pages > 1) {
					isAnimWebP = true;
				}
			} catch {}
		}

		// Se for imagem estática (exceto GIF e WebP animado), use sharp
		if (mimeType.startsWith("image/") && mimeType !== "image/gif" && !isAnimWebP) {
			let workingBuffer = rawBuffer;
			if (transforms.rotation || transforms.flipH || transforms.flipV) {
				let transformed = sharp(rawBuffer);
				if (transforms.rotation) transformed = transformed.rotate(transforms.rotation);
				if (transforms.flipV) transformed = transformed.flip();
				if (transforms.flipH) transformed = transformed.flop();
				workingBuffer = await transformed.png({ compressionLevel: 1 }).toBuffer();
			}

			const image = sharp(workingBuffer);
			const metadata = await image.metadata();
			const webpQuality = isHqQuality ? 85 : WHATSAPP_STICKER.STATIC_QUALITY;

			// Determinar dimensões para corte quadrado
			const size = Math.min(metadata.width, metadata.height);
			let left = 0;
			let top = 0;

			// Verificar se o cropMode é uma porcentagem (vinda do LLM ou manual)
			const percentage = parseFloat(cropMode);

			let result;
			if (!isNaN(percentage)) {
				if (metadata.width > metadata.height) {
					// Paisagem: Ajustar horizontal (X)
					const centerX = (metadata.width * percentage) / 100;
					left = Math.max(0, Math.min(metadata.width - size, centerX - size / 2));
					top = 0;
				} else {
					// Retrato: Ajustar vertical (Y)
					const centerY = (metadata.height * percentage) / 100;
					top = Math.max(0, Math.min(metadata.height - size, centerY - size / 2));
					left = 0;
				}
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: webpQuality,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropMode === "center") {
				left = Math.max(0, (metadata.width - size) / 2);
				top = Math.max(0, (metadata.height - size) / 2);
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: webpQuality,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropMode === "top") {
				left = Math.max(0, (metadata.width - size) / 2);
				top = 0;
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: webpQuality,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropMode === "bottom") {
				left = Math.max(0, (metadata.width - size) / 2);
				top = Math.max(0, metadata.height - size);
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: webpQuality,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropMode === "stretch") {
				result = await image
					.resize(TARGET_SIZE, TARGET_SIZE, { fit: "fill" })
					.webp({
						quality: webpQuality,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropMode === "hq_aspect" || cropMode === "hq" || cropMode === "longhq") {
				// Redimensiona para caber em 512x512 mantendo o aspecto original, sem adicionar bordas
				result = await image
					.resize(TARGET_SIZE, TARGET_SIZE, { fit: "inside" })
					.webp({
						quality: 85,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropMode === "transparent" || cropMode === "long") {
				// Redimensiona para caber em 512x512 mantendo o aspecto e adiciona bordas transparentes
				result = await image
					.resize(TARGET_SIZE, TARGET_SIZE, {
						fit: "contain",
						background: { r: 0, g: 0, b: 0, alpha: 0 }
					})
					.webp({
						quality: webpQuality,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else {
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: webpQuality,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			}

			return result;
		} else if (isVideo(mimeType) || isAnimWebP) {
			// Para vídeos, GIFs e WebP animado, processa via ffmpeg
			const inputPath = await saveTempMedia(rawBuffer, mimeType);
			const filterOptions = { cropMode, qualityMode, transforms };
			const filterBuilder = (profile) =>
				buildAnimatedVideoFilter(filterOptions, profile.maxSize || TARGET_SIZE, profile.fps || FPS);

			try {
				let profiles;
				if (qualityMode === "long" || qualityMode === "longhq") {
					const mediaDuration = await getMediaDuration(inputPath);
					profiles = buildLongAnimatedProfiles(qualityMode, mediaDuration);
				} else if (qualityMode === "hq") {
					profiles = ANIMATED_HQ_PROFILES;
				} else {
					profiles = ANIMATED_FALLBACK_PROFILES;
				}

				const processedBuffer = await encodeAnimatedWebPWithFallback(
					inputPath,
					filterBuilder,
					profiles,
					cropMode
				);
				return processedBuffer;
			} finally {
				await fs.unlink(inputPath).catch(() => {});
			}
		} else {
			throw new Error(`Tipo de mídia não suportado: ${mimeType}`);
		}
	} catch (error) {
		logger.error(
			`Erro ao processar mídia em quadrado [${Date.now() - fnStart}ms]: ${error.message}`
		);
		logger.error(error.stack);
		throw error;
	}
}

/**
 * Função middleware para processar mídia antes de enviá-la para o comando de sticker
 * @param {Buffer|Object} mediaBuffer - Buffer ou objeto com a mídia
 * @param {string} mimeType - Tipo MIME da mídia
 * @param {string|Object} optionsOrCropType - Opções ou tipo de corte
 * @returns {Promise<Buffer>} - Buffer da mídia processada
 */
async function processMediaToSquare(mediaBuffer, mimeType, optionsOrCropType) {
	try {
		return await makeSquareMedia(mediaBuffer, mimeType, optionsOrCropType);
	} catch (error) {
		logger.error(`Erro ao processar mídia em formato quadrado:`, error);
		throw error;
	}
}

/**
 * Garante que a mídia do sticker citado esteja em WebP para envio como sound sticker.
 * Preserva WebP já pronto (estático ou animado) quando não há ajustes visuais e converte quando necessário.
 * @param {Object} stickerMsg - Mensagem de sticker citada
 * @param {Object|null} [stickerOptions=null] - Opções visuais combinadas
 * @returns {Promise<Object>} - Objeto MessageMedia pronto para envio
 */
async function prepareStickerMediaForAudioFusion(stickerMsg, stickerOptions = null) {
	const stickerMedia = await stickerMsg.downloadMedia();
	if (!stickerMedia || (!stickerMedia.data && !stickerMedia.url)) {
		throw new Error("Não foi possível baixar a figurinha citada pelo áudio");
	}
	const mime = String(stickerMedia.mimetype || "").toLowerCase();
	const hasVisualAdjustments = Boolean(stickerOptions?.hasExplicitVisualChanges);
	if (
		!hasVisualAdjustments &&
		(mime.includes("webp") || (!stickerMedia.data && stickerMedia.url))
	) {
		return {
			mimetype: stickerMedia.mimetype || "image/webp",
			data: stickerMedia.data,
			url: stickerMedia.url,
			filename: stickerMedia.filename || `sticker-${Date.now()}.webp`,
			isMessageMedia: true
		};
	}

	const webpBuffer = await makeSquareMedia(
		stickerMedia,
		stickerMedia.mimetype || "image/webp",
		stickerOptions || "transparent"
	);
	return {
		mimetype: "image/webp",
		data: webpBuffer.toString("base64"),
		filename: `sticker-${Date.now()}.webp`,
		isMessageMedia: true
	};
}

/**
 * Converte um arquivo de mídia de entrada (áudio ou vídeo) para OGG Opus via FFmpeg.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<{audioBuffer: Buffer, duration: number}>}
 */
async function transcodeToOpusOgg(inputPath, outputPath) {
	let probeData;
	try {
		probeData = await new Promise((resolve, reject) => {
			ffmpeg.ffprobe(inputPath, (err, metadata) => {
				if (err) reject(err);
				else resolve(metadata);
			});
		});
	} catch (probeErr) {
		const err = new Error("Arquivo de áudio ilegível ou corrompido");
		err.code = "AUDIO_UNREADABLE";
		err.cause = probeErr;
		throw err;
	}

	const streams = Array.isArray(probeData?.streams) ? probeData.streams : [];
	const audioStream = streams.find((s) => s.codec_type === "audio");
	if (!audioStream) {
		const err = new Error("Arquivo sem faixa de áudio");
		err.code = "VIDEO_WITHOUT_AUDIO";
		throw err;
	}

	const duration =
		parseFfprobeDuration(probeData?.format?.duration) ??
		parseFfprobeDuration(audioStream.duration) ??
		0;
	if (duration > 240) {
		const err = new Error("Áudio muito longo para figurinha com som");
		err.code = "VIDEO_TOO_LONG";
		throw err;
	}

	await acquireFFmpegSlot();
	try {
		await new Promise((resolve, reject) => {
			ffmpeg(inputPath)
				.noVideo()
				.audioCodec("libopus")
				.audioBitrate("48k")
				.audioFrequency(48000)
				.audioChannels(1)
				.format("ogg")
				.output(outputPath)
				.on("end", resolve)
				.on("error", reject)
				.run();
		});
	} catch (convErr) {
		const err = new Error("Falha ao converter áudio para formato compatível");
		err.code = "AUDIO_CONVERSION_FAILED";
		err.cause = convErr;
		throw err;
	} finally {
		releaseFFmpegSlot();
	}

	const audioBuffer = await fs.readFile(outputPath);
	if (!audioBuffer || audioBuffer.length === 0) {
		const err = new Error("Áudio convertido resultou vazio");
		err.code = "AUDIO_EMPTY";
		throw err;
	}
	return { audioBuffer, duration };
}

/**
 * Converte um buffer de áudio (mp3, m4a, ogg, wav, etc.) para OGG Opus pronto para sticker com som.
 * @param {Buffer} audioBuffer
 * @param {string} [mimeType="audio/ogg"]
 * @param {string} [filename=""]
 * @returns {Promise<{audioBuffer: Buffer, duration: number}>}
 */
async function convertAudioBufferToOpus(audioBuffer, mimeType = "audio/ogg", filename = "") {
	const inputPath = await saveTempMedia(audioBuffer, mimeType, filename);
	const outputPath = `${inputPath}.opus.ogg`;
	try {
		return await transcodeToOpusOgg(inputPath, outputPath);
	} finally {
		await fs.unlink(inputPath).catch(() => {});
		await fs.unlink(outputPath).catch(() => {});
	}
}

/**
 * Mapeia erros de processamento de áudio/figurinha para mensagens amigáveis ao usuário sem expor caminhos ou detalhes internos.
 * @param {Error} err
 * @returns {string}
 */
function formatFriendlyAudioStickerError(err) {
	switch (err?.code) {
		case "VIDEO_WITHOUT_AUDIO":
			return "❌ Esse arquivo não possui nenhuma faixa de áudio válida para colocar na figurinha.";
		case "VIDEO_TOO_LONG":
			return "❌ O áudio é muito longo (máximo de 4 minutos para figurinhas com som).";
		case "AUDIO_UNREADABLE":
			return "❌ Não consegui ler esse arquivo de áudio. Ele pode estar corrompido ou em um formato incompatível.";
		case "AUDIO_CONVERSION_FAILED":
			return "❌ Não consegui converter esse áudio para o formato de figurinha com som. Tente enviar outro áudio (como MP3, OGG ou gravação de voz).";
		case "AUDIO_EMPTY":
			return "❌ O áudio ficou vazio ou mudo depois da conversão. Tente enviar outro arquivo.";
		default:
			return "❌ Não consegui criar a figurinha com som com esse áudio. Tente enviar outro arquivo ou gravar novamente.";
	}
}

/**
 * Funde uma figurinha (citada pelo áudio) com um áudio para gerar um sticker com som.
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>}
 */
async function createAudioStickerFromAudioAndSticker({
	bot,
	message,
	args,
	group,
	chatId,
	audioMsg,
	quotedStickerMsg,
	cropType,
	stickerOptions = null
}) {
	const parsedOptions =
		stickerOptions ||
		parseStickerArgs(args, { cropMode: cropType !== "transparent" ? cropType : null });
	return await telemetry.withSpan(
		"sticker sound.fuse",
		{ attributes: { "ravena.sticker.crop_type": parsedOptions.cropMode } },
		async (span) => {
			if (bot?.useTelegram || bot?.useDiscord) {
				telemetry.setAttrs({
					"app.outcome": "rejected",
					"app.reject.reason": "unsupported_platform"
				});
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content: "Figurinhas com som só são suportadas no WhatsApp por enquanto."
				});
			}

			const parentType = String(quotedStickerMsg?.type || "").toLowerCase();
			if (!quotedStickerMsg || parentType !== "sticker") {
				telemetry.setAttrs({
					"app.outcome": "rejected",
					"app.reject.reason": "audio_without_quoted_sticker"
				});
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content:
						"Para criar uma figurinha com som, responda a uma figurinha com um áudio (ou arquivo de áudio) e use !s (ou use !sa em um vídeo)."
				});
			}

			const audioSeconds = Number(
				audioMsg?.content?.seconds || audioMsg?.content?._mediaDetails?.seconds || 0
			);
			if (audioSeconds > 240) {
				telemetry.setAttrs({
					"app.outcome": "rejected",
					"app.reject.reason": "audio_too_long"
				});
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content: "❌ O áudio é muito longo (máximo de 4 minutos para figurinhas com som)."
				});
			}

			const audioMedia =
				audioMsg?.content?.data || audioMsg?.content?.url
					? audioMsg.content
					: typeof audioMsg.downloadMedia === "function"
						? await audioMsg.downloadMedia().catch(() => null)
						: null;
			if (!audioMedia || (!audioMedia.data && !audioMedia.url)) {
				telemetry.setAttrs({
					"app.outcome": "rejected",
					"app.reject.reason": "audio_download_failed"
				});
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content: "❌ Não consegui baixar o áudio marcado (a mídia expirou ou ficou indisponível)."
				});
			}

			let normalizedAudioData = audioMedia.data;
			let normalizedAudioMime = audioMedia.mimetype || "audio/ogg; codecs=opus";
			if (audioMedia.data) {
				try {
					const rawAudioBuffer = Buffer.from(
						String(audioMedia.data).replace(/^data:[^;]+;base64,/, ""),
						"base64"
					);
					const converted = await convertAudioBufferToOpus(
						rawAudioBuffer,
						normalizedAudioMime,
						audioMedia.filename || ""
					);
					normalizedAudioData = converted.audioBuffer.toString("base64");
					normalizedAudioMime = "audio/ogg; codecs=opus";
				} catch (convErr) {
					logger.warn(
						`[createAudioStickerFromAudioAndSticker] Falha ao converter áudio (${convErr.code || "ERR"}): ${convErr.message}`
					);
					telemetry.setAttrs({
						"app.outcome": "rejected",
						"app.reject.reason": convErr.code || "audio_conversion_failed"
					});
					await message.origin.react("❌");
					return new ReturnMessage({
						chatId,
						content: formatFriendlyAudioStickerError(convErr)
					});
				}
			}

			let stickerMedia;
			try {
				stickerMedia = await prepareStickerMediaForAudioFusion(quotedStickerMsg, parsedOptions);
			} catch (dlErr) {
				logger.warn(`[createAudioStickerFromAudioAndSticker] ${dlErr.message}`);
				telemetry.setAttrs({
					"app.outcome": "rejected",
					"app.reject.reason": "sticker_download_failed"
				});
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content:
						"❌ Não consegui baixar ou processar a figurinha marcada pelo áudio (a mídia pode ter expirado)."
				});
			}

			const nameArgs = parsedOptions.remainingArgs || [];
			const stickerName = nameArgs.length > 0 ? nameArgs.join(" ") : group ? group.name : "sticker";

			cmdUsage.logFixedCommandUsage({
				timestamp: Date.now(),
				command: "sticker",
				user: message.author,
				groupId: chatId,
				args: args.join(" "),
				info: {
					cropType: parsedOptions.cropMode,
					qualityMode: parsedOptions.qualityMode,
					mimeType: normalizedAudioMime,
					hasAudio: true
				}
			});

			telemetry.setAttrs({
				"ravena.sticker.has_audio": true,
				"ravena.sticker.crop_type": parsedOptions.cropMode
			});
			span?.setAttribute("ravena.sticker.audio_mime", String(normalizedAudioMime));

			return [
				new ReturnMessage({
					chatId,
					content: stickerMedia,
					options: {
						sendMediaAsSticker: true,
						stickerAudio: {
							data: normalizedAudioData,
							url: normalizedAudioData ? undefined : audioMedia.url,
							mimetype: normalizedAudioMime,
							filename: `sticker-audio-${Date.now()}.ogg`
						},
						stickerAuthor: bot?.nomeExibir || "ravena",
						stickerName,
						quotedMessageId: message.origin.id._serialized
					}
				})
			];
		}
	);
}

/**
 * Se a figurinha extraída possuir áudio embutido, anexa também o áudio original na resposta.
 */
async function appendAudioStickerExtraction({ chatId, message, quotedMsg, visualReturnMessage }) {
	const hasEmbeddedAudio = Boolean(
		quotedMsg?.content?.audioMessage ||
		quotedMsg?.content?._mediaDetails?.Audio?.AudioMessage ||
		quotedMsg?.content?._mediaDetails?.audioMessage
	);
	if (!hasEmbeddedAudio || typeof quotedMsg.downloadStickerAudio !== "function") {
		return visualReturnMessage;
	}

	const audioMedia = await quotedMsg.downloadStickerAudio().catch((err) => {
		logger.warn(`[appendAudioStickerExtraction] Falha ao baixar áudio do sticker: ${err.message}`);
		return null;
	});
	if (!audioMedia || (!audioMedia.data && !audioMedia.url)) {
		return visualReturnMessage;
	}

	telemetry.setAttrs({ "ravena.sticker.extracted_audio": true });

	const audioReturnMessage = new ReturnMessage({
		chatId,
		content: {
			mimetype: audioMedia.mimetype || "audio/ogg; codecs=opus",
			data: audioMedia.data,
			url: audioMedia.url,
			filename: audioMedia.filename || "sticker-audio.ogg",
			isMessageMedia: true
		},
		options: {
			sendMediaAsSticker: false,
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin
		}
	});

	return [visualReturnMessage, audioReturnMessage];
}

/**
 * Extrai a faixa de áudio de um vídeo em OGG Opus e valida se existe áudio e duração <= 240s.
 * @param {Buffer} videoBuffer - Buffer do vídeo
 * @param {string} mimeType - Mimetype do vídeo
 * @returns {Promise<{audioBuffer: Buffer, duration: number}>}
 */
async function extractAudioFromVideoBuffer(videoBuffer, mimeType = "video/mp4") {
	const videoPath = await saveTempMedia(videoBuffer, mimeType);
	const audioPath = `${videoPath}.ogg`;
	try {
		return await transcodeToOpusOgg(videoPath, audioPath);
	} finally {
		await fs.unlink(videoPath).catch(() => {});
		await fs.unlink(audioPath).catch(() => {});
	}
}

/**
 * Cria figurinha com som diretamente a partir de um vídeo (!sa / !saudio), aceitando args combináveis.
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>}
 */
async function audioStickerFromVideoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const stickerOptions = parseStickerArgs(args);
	telemetry.setAttrs({
		"ravena.sticker.crop_type": stickerOptions.cropMode,
		"ravena.sticker.quality_mode": stickerOptions.qualityMode,
		"ravena.sticker.has_audio": true
	});

	if (bot?.useTelegram || bot?.useDiscord) {
		telemetry.setAttrs({
			"app.outcome": "rejected",
			"app.reject.reason": "unsupported_platform"
		});
		await message.origin.react("❌");
		return new ReturnMessage({
			chatId,
			content: "Figurinhas com som só são suportadas no WhatsApp por enquanto."
		});
	}

	let videoMsg = null;
	let preloadedVideoMedia = null;
	let detectedVideoMime = null;

	if (message.type === "video") {
		videoMsg = message;
	} else if (message.type === "audio" || message.type === "ptt") {
		const quotedStickerMsg =
			typeof message.origin?.getQuotedMessage === "function"
				? await message.origin.getQuotedMessage().catch(() => null)
				: null;
		return await createAudioStickerFromAudioAndSticker({
			bot,
			message,
			args,
			group,
			chatId,
			audioMsg: message,
			quotedStickerMsg,
			cropType: stickerOptions.cropMode,
			stickerOptions
		});
	} else if (message.type === "document") {
		const docMedia = message.content?.data
			? message.content
			: typeof message.downloadMedia === "function"
				? await message.downloadMedia().catch(() => null)
				: null;
		const docClass = classifyDocumentMedia(message, docMedia);
		if (docClass.kind === "audio") {
			const quotedStickerMsg =
				typeof message.origin?.getQuotedMessage === "function"
					? await message.origin.getQuotedMessage().catch(() => null)
					: null;
			return await createAudioStickerFromAudioAndSticker({
				bot,
				message,
				args,
				group,
				chatId,
				audioMsg: docMedia
					? {
							...message,
							content: { ...message.content, ...docMedia, mimetype: docClass.mimeType }
						}
					: message,
				quotedStickerMsg,
				cropType: stickerOptions.cropMode,
				stickerOptions
			});
		}
		if (docClass.kind === "video") {
			videoMsg = message;
			preloadedVideoMedia = docMedia;
			detectedVideoMime = docClass.mimeType;
		}
	} else {
		const quotedMsg =
			typeof message.origin?.getQuotedMessage === "function"
				? await message.origin.getQuotedMessage().catch(() => null)
				: null;
		const qType = String(quotedMsg?.type || "").toLowerCase();
		if (qType === "video") {
			videoMsg = quotedMsg;
		} else if (qType === "audio" || qType === "ptt") {
			const quotedStickerMsg =
				typeof quotedMsg.origin?.getQuotedMessage === "function"
					? await quotedMsg.origin.getQuotedMessage().catch(() => null)
					: null;
			return await createAudioStickerFromAudioAndSticker({
				bot,
				message,
				args,
				group,
				chatId,
				audioMsg: quotedMsg,
				quotedStickerMsg,
				cropType: stickerOptions.cropMode,
				stickerOptions
			});
		} else if (qType === "document") {
			const docMedia = quotedMsg.content?.data
				? quotedMsg.content
				: typeof quotedMsg.downloadMedia === "function"
					? await quotedMsg.downloadMedia().catch(() => null)
					: null;
			const docClass = classifyDocumentMedia(quotedMsg, docMedia);
			if (docClass.kind === "audio") {
				const quotedStickerMsg =
					typeof quotedMsg.origin?.getQuotedMessage === "function"
						? await quotedMsg.origin.getQuotedMessage().catch(() => null)
						: null;
				return await createAudioStickerFromAudioAndSticker({
					bot,
					message,
					args,
					group,
					chatId,
					audioMsg: docMedia
						? {
								...quotedMsg,
								content: { ...quotedMsg.content, ...docMedia, mimetype: docClass.mimeType }
							}
						: quotedMsg,
					quotedStickerMsg,
					cropType: stickerOptions.cropMode,
					stickerOptions
				});
			}
			if (docClass.kind === "video") {
				videoMsg = quotedMsg;
				preloadedVideoMedia = docMedia;
				detectedVideoMime = docClass.mimeType;
			}
		}
	}

	if (!videoMsg) {
		telemetry.setAttrs({
			"app.outcome": "rejected",
			"app.reject.reason": "missing_video_for_saudio"
		});
		await message.origin.react("❌");
		return new ReturnMessage({
			chatId,
			content:
				"Manda um vídeo com !sa na legenda ou responde a um vídeo com !sa para criar uma figurinha com som! 🎬🔊"
		});
	}

	let videoMedia = preloadedVideoMedia;
	if (!videoMedia) {
		if (videoMsg.content && videoMsg.content.data) {
			videoMedia = videoMsg.content;
		} else if (typeof videoMsg.downloadMedia === "function") {
			videoMedia = await videoMsg.downloadMedia().catch(() => null);
		}
	}

	if (!videoMedia || !videoMedia.data) {
		telemetry.setAttrs({
			"app.outcome": "rejected",
			"app.reject.reason": "video_download_failed"
		});
		await message.origin.react("❌");
		return new ReturnMessage({
			chatId,
			content:
				"❌ Não consegui baixar esse vídeo (pode ter expirado ou ser visualização única protegida)."
		});
	}

	const mimeType = detectedVideoMime || videoMedia.mimetype || "video/mp4";
	const videoBuffer = Buffer.from(videoMedia.data, "base64");

	let extracted;
	try {
		extracted = await extractAudioFromVideoBuffer(videoBuffer, mimeType);
	} catch (err) {
		if (err.code === "VIDEO_WITHOUT_AUDIO") {
			telemetry.setAttrs({
				"app.outcome": "rejected",
				"app.reject.reason": "video_without_audio"
			});
			await message.origin.react("❌");
			return new ReturnMessage({
				chatId,
				content: "❌ Esse vídeo não tem faixa de áudio. Para figurinha sem som, use !s."
			});
		}
		if (err.code === "VIDEO_TOO_LONG") {
			telemetry.setAttrs({
				"app.outcome": "rejected",
				"app.reject.reason": "video_too_long"
			});
			await message.origin.react("❌");
			return new ReturnMessage({
				chatId,
				content: "❌ O vídeo é muito longo (máximo de 4 minutos para figurinhas com som)."
			});
		}
		telemetry.setAttrs({
			"app.outcome": "rejected",
			"app.reject.reason": err.code || "video_audio_extract_failed"
		});
		await message.origin.react("❌");
		return new ReturnMessage({
			chatId,
			content: formatFriendlyAudioStickerError(err)
		});
	}

	let finalStickerOptions = stickerOptions;
	if (stickerOptions.cropMode === "llm") {
		const percentage = await getLLMCropPercentage(videoMedia, mimeType);
		finalStickerOptions = { ...stickerOptions, cropMode: String(percentage) };
	}

	const processedBuffer = await processMediaToSquare(videoMedia, mimeType, finalStickerOptions);
	telemetry.setAttrs({
		"ravena.sticker.crop_type": String(finalStickerOptions.cropMode),
		"ravena.sticker.quality_mode": finalStickerOptions.qualityMode,
		"ravena.sticker.mime_type": mimeType,
		"ravena.sticker.size_bytes": processedBuffer.length,
		"ravena.sticker.has_audio": true
	});

	const stickerMedia = {
		mimetype: "image/webp",
		data: processedBuffer.toString("base64"),
		filename: `sticker-${Date.now()}.webp`,
		isMessageMedia: true
	};
	const nameArgs = stickerOptions.remainingArgs || [];
	const stickerName = nameArgs.length > 0 ? nameArgs.join(" ") : group ? group.name : "sticker";

	cmdUsage.logFixedCommandUsage({
		timestamp: Date.now(),
		command: "sticker",
		user: message.author,
		groupId: chatId,
		args: args.join(" "),
		info: {
			cropType: finalStickerOptions.cropMode,
			qualityMode: finalStickerOptions.qualityMode,
			mimeType,
			hasAudio: true,
			fromVideo: true
		}
	});

	return [
		new ReturnMessage({
			chatId,
			content: stickerMedia,
			options: {
				sendMediaAsSticker: true,
				stickerAudio: {
					data: extracted.audioBuffer.toString("base64"),
					mimetype: "audio/ogg; codecs=opus",
					filename: `sticker-audio-${Date.now()}.ogg`
				},
				stickerAuthor: bot?.nomeExibir || "ravena",
				stickerName,
				quotedMessageId: message.origin.id._serialized
			}
		})
	];
}

/**
 * Cria um sticker quadrado a partir de uma mídia, aplicando diferentes tipos de corte
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @param {string} cropType - Tipo de corte: 'center', 'top', 'bottom' ou 'stretch'
 * @returns {Promise<ReturnMessage>} - ReturnMessage com o sticker
 */
async function squareStickerCommand(bot, message, args, group, cropType) {
	const chatId = message.group ?? message.author;
	const baseOptions =
		cropType === "hq"
			? { hq: true }
			: cropType === "long"
				? { longo: true }
				: cropType === "longhq"
					? { hq: true, longo: true }
					: cropType && cropType !== "transparent"
						? { cropMode: cropType }
						: {};
	const stickerOptions = parseStickerArgs(args, baseOptions);
	telemetry.setAttrs({
		"ravena.sticker.crop_type": stickerOptions.cropMode,
		"ravena.sticker.quality_mode": stickerOptions.qualityMode,
		"ravena.sticker.has_audio": false
	});

	try {
		let mediaBuffer, mimeType, quotedMessageId;

		// Extrair mídia e informações necessárias da mensagem direta ou citada
		if (message.type === "audio" || message.type === "ptt") {
			const quotedStickerMsg =
				typeof message.origin?.getQuotedMessage === "function"
					? await message.origin.getQuotedMessage().catch(() => null)
					: null;
			const quotedParentType = String(quotedStickerMsg?.type || "").toLowerCase();
			if (!["image", "video", "gif"].includes(quotedParentType)) {
				return await createAudioStickerFromAudioAndSticker({
					bot,
					message,
					args,
					group,
					chatId,
					audioMsg: message,
					quotedStickerMsg,
					cropType: stickerOptions.cropMode,
					stickerOptions
				});
			}
		}
		if (message.type === "document") {
			const docMedia =
				message.content && message.content.data
					? message.content
					: typeof message.downloadMedia === "function"
						? await message.downloadMedia().catch(() => null)
						: null;
			const docClass = classifyDocumentMedia(message, docMedia);
			if (docClass.kind === "audio") {
				const quotedStickerMsg =
					typeof message.origin?.getQuotedMessage === "function"
						? await message.origin.getQuotedMessage().catch(() => null)
						: null;
				return await createAudioStickerFromAudioAndSticker({
					bot,
					message,
					args,
					group,
					chatId,
					audioMsg: docMedia
						? {
								...message,
								content: { ...message.content, ...docMedia, mimetype: docClass.mimeType }
							}
						: message,
					quotedStickerMsg,
					cropType: stickerOptions.cropMode,
					stickerOptions
				});
			}
			if (docClass.kind === "image" || docClass.kind === "video") {
				if (!docMedia || !docMedia.data) {
					await message.origin.react("❌");
					return new ReturnMessage({
						chatId,
						content: "❌ Não consegui baixar esse arquivo (pode ter expirado ou ser muito grande)."
					});
				}
				mediaBuffer = docMedia;
				mimeType = docClass.mimeType;
				quotedMessageId = message.origin.id._serialized;
			} else {
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content:
						"Esse tipo de arquivo não vira figurinha! Só aceito imagens, vídeos, figurinhas e áudios (ou documentos nesses formatos, ou marca alguém com @ pra usar a foto de perfil)."
				});
			}
		} else if (message.type === "image" || message.type === "video" || message.type === "gif") {
			// Mídia na mensagem atual
			if (message.content && message.content.data) {
				mediaBuffer = message.content;
				mimeType = message.content.mimetype;
			} else if (typeof message.downloadMedia === "function") {
				const media = await message.downloadMedia();
				if (!media) throw new Error("Falha ao baixar mídia");
				mediaBuffer = media;
				mimeType = media.mimetype;
			} else {
				throw new Error("Formato de mídia não reconhecido");
			}

			quotedMessageId = message.origin.id._serialized;
		} else {
			// Mídia na mensagem citada
			const quotedMsg = await message.origin.getQuotedMessage();

			// Se não há mensagem citada nem mídia direta
			if (!quotedMsg) {
				await message.origin.react("❌");
				if (message.hasQuotedMsg) {
					return new ReturnMessage({
						chatId,
						content:
							"⚠️ Não consegui baixar a mídia marcada. O arquivo pode ter expirado ou saído do cache."
					});
				}
				return new ReturnMessage({
					chatId,
					content:
						"Manda uma imagem ou vídeo na legenda do comando, responde a uma mídia ou marca alguém com @ pra usar a foto de perfil! 🖼️"
				});
			}

			// Verificar se o tipo de mídia é suportado
			const mediaType = quotedMsg.type.toLowerCase();

			if (mediaType === "sticker") {
				// Baixa o sticker original para extrair a mídia
				const stickerMedia = await quotedMsg.downloadMedia();
				if (!stickerMedia || !stickerMedia.data || !stickerMedia.mimetype) {
					telemetry.setAttrs({
						"app.outcome": "rejected",
						"app.reject.reason": "sticker_download_failed"
					});
					await message.origin.react("❌");
					return new ReturnMessage({
						chatId,
						content:
							"❌ Não consegui baixar a figurinha marcada (a mídia expirou ou ficou indisponível)."
					});
				}

				if (String(stickerMedia.mimetype).toLowerCase().includes("was")) {
					telemetry.setAttrs({
						"app.outcome": "rejected",
						"app.reject.reason": "unsupported_lottie_sticker"
					});
					await message.origin.react("❌");
					return new ReturnMessage({
						chatId,
						content: "Figurinhas animadas Lottie (.was) ainda não são suportadas para extração."
					});
				}

				// Verifica se é WebP para processamento especial
				if (stickerMedia.mimetype.includes("webp")) {
					try {
						const buffer = Buffer.from(stickerMedia.data, "base64");
						const image = sharp(buffer, { animated: true });
						const metadata = await image.metadata();

						if (metadata.pages > 1) {
							// WebP Animado -> GIF (via sharp) -> MP4 (via ffmpeg)
							const gifBuffer = await image.gif({ loop: 0 }).toBuffer();
							const inputPath = await saveTempMedia(gifBuffer, "image/gif");
							const outputPath = inputPath.replace(".gif", ".mp4");

							await new Promise((resolve, reject) => {
								ffmpeg(inputPath)
									.outputOptions([
										"-y",
										"-an",
										"-c:v libx264",
										"-preset veryfast",
										"-crf 32",
										"-pix_fmt yuv420p",
										"-movflags faststart",
										"-vf scale=trunc(iw/2)*2:trunc(ih/2)*2"
									])
									.output(outputPath)
									.on("end", resolve)
									.on("error", (err, stdout, stderr) => {
										logger.error(`FFmpeg error: ${err.message}`);
										logger.error(`FFmpeg stderr: ${stderr}`);
										reject(err);
									})
									.run();
							});

							const mp4Buffer = await fs.readFile(outputPath);
							const mp4Media = {
								mimetype: "video/mp4",
								data: mp4Buffer.toString("base64"),
								filename: "sticker.mp4",
								isMessageMedia: true
							};

							await fs.unlink(inputPath).catch(() => {});
							await fs.unlink(outputPath).catch(() => {});

							return await appendAudioStickerExtraction({
								chatId,
								message,
								quotedMsg,
								visualReturnMessage: new ReturnMessage({
									chatId,
									content: mp4Media,
									options: {
										sendMediaAsSticker: false,
										caption: "Sticker Animation",
										quotedMessageId: message.origin.id._serialized,
										goReply: message.origin
									}
								})
							});
						} else if (metadata.hasAlpha) {
							// WebP Transparente -> PNG (Documento)
							const pngBuffer = await image.png().toBuffer();
							const pngMedia = {
								mimetype: "image/png",
								data: pngBuffer.toString("base64"),
								filename: "sticker.png",
								isMessageMedia: true
							};

							return await appendAudioStickerExtraction({
								chatId,
								message,
								quotedMsg,
								visualReturnMessage: new ReturnMessage({
									chatId,
									content: pngMedia,
									options: {
										sendMediaAsDocument: true,
										caption: "Sticker Transparente",
										quotedMessageId: message.origin.id._serialized,
										goReply: message.origin
									}
								})
							});
						}
					} catch (error) {
						logger.error("Erro ao processar sticker especial:", error);
					}
				}

				// Retorna a mídia original (não como sticker) e, se houver, o áudio embutido
				return await appendAudioStickerExtraction({
					chatId,
					message,
					quotedMsg,
					visualReturnMessage: new ReturnMessage({
						chatId,
						content: stickerMedia,
						options: {
							sendMediaAsSticker: false,
							caption: "Sticker Media",
							quotedMessageId: message.origin.id._serialized,
							goReply: message.origin
						}
					})
				});
			} else if (mediaType === "audio" || mediaType === "ptt") {
				const quotedStickerMsg =
					typeof quotedMsg.origin?.getQuotedMessage === "function"
						? await quotedMsg.origin.getQuotedMessage().catch(() => null)
						: null;
				return await createAudioStickerFromAudioAndSticker({
					bot,
					message,
					args,
					group,
					chatId,
					audioMsg: quotedMsg,
					quotedStickerMsg,
					cropType: stickerOptions.cropMode,
					stickerOptions
				});
			} else if (mediaType === "document") {
				const docMedia =
					quotedMsg.content && quotedMsg.content.data
						? quotedMsg.content
						: typeof quotedMsg.downloadMedia === "function"
							? await quotedMsg.downloadMedia().catch(() => null)
							: null;
				const docClass = classifyDocumentMedia(quotedMsg, docMedia);
				if (docClass.kind === "audio") {
					const quotedStickerMsg =
						typeof quotedMsg.origin?.getQuotedMessage === "function"
							? await quotedMsg.origin.getQuotedMessage().catch(() => null)
							: null;
					return await createAudioStickerFromAudioAndSticker({
						bot,
						message,
						args,
						group,
						chatId,
						audioMsg: docMedia
							? {
									...quotedMsg,
									content: { ...quotedMsg.content, ...docMedia, mimetype: docClass.mimeType }
								}
							: quotedMsg,
						quotedStickerMsg,
						cropType: stickerOptions.cropMode,
						stickerOptions
					});
				}
				if (docClass.kind === "image" || docClass.kind === "video") {
					if (!docMedia || !docMedia.data) {
						await message.origin.react("❌");
						return new ReturnMessage({
							chatId,
							content:
								"❌ Não consegui baixar esse arquivo (pode ter expirado ou ser visualização única protegida)."
						});
					}
					mediaBuffer = docMedia;
					mimeType = docClass.mimeType;
					quotedMessageId = message.origin.id._serialized;
				} else {
					await message.origin.react("❌");
					return new ReturnMessage({
						chatId,
						content:
							"Esse tipo de arquivo não vira figurinha! Só aceito imagens, vídeos, figurinhas e áudios (ou documentos nesses formatos, ou marca alguém com @ pra usar a foto de perfil)."
					});
				}
			} else if (["image", "video", "gif"].includes(mediaType)) {
				const media = await quotedMsg.downloadMedia();
				if (!media || !media.data || !media.mimetype) {
					await message.origin.react("❌");
					return new ReturnMessage({
						chatId,
						content:
							"❌ Não consegui baixar essa mídia (pode ter expirado ou ser visualização única protegida)."
					});
				}
				mediaBuffer = media;
				mimeType = media.mimetype;
				quotedMessageId = message.origin.id._serialized;
			} else {
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content:
						"Esse tipo de arquivo não vira figurinha! Só aceito imagens, vídeos, figurinhas e áudios (ou documentos nesses formatos, ou marca alguém com @ pra usar a foto de perfil)."
				});
			}
		}

		// Determinar o tipo de corte final (se for LLM, fazer a query agora)
		let finalStickerOptions = stickerOptions;
		if (stickerOptions.cropMode === "llm") {
			const percentage = await getLLMCropPercentage(mediaBuffer, mimeType);
			finalStickerOptions = { ...stickerOptions, cropMode: String(percentage) };
		}

		// Processar a mídia para torná-la quadrada no padrão WhatsApp
		const processedBuffer = await processMediaToSquare(mediaBuffer, mimeType, finalStickerOptions);
		telemetry.setAttrs({
			"ravena.sticker.crop_type":
				stickerOptions.cropMode === "llm" ? "llm" : String(finalStickerOptions.cropMode),
			"ravena.sticker.quality_mode": finalStickerOptions.qualityMode,
			"ravena.sticker.mime_type": mimeType || "unknown",
			"ravena.sticker.size_bytes": processedBuffer.length
		});

		// Monta objeto de mídia direto do buffer em memória (sem I/O de arquivo temporário)
		const processedMedia = {
			mimetype: "image/webp",
			data: processedBuffer.toString("base64"),
			filename: `sticker-${Date.now()}.webp`,
			isMessageMedia: true
		};

		// Extrair nome do sticker dos args restantes ou usa nome do grupo
		const nameArgs = stickerOptions.remainingArgs || [];
		const stickerName = nameArgs.length > 0 ? nameArgs.join(" ") : group ? group.name : "sticker";

		// Log usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "sticker",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				cropType: finalStickerOptions.cropMode,
				qualityMode: finalStickerOptions.qualityMode,
				mimeType
			}
		});

		// Cria ReturnMessage com opções para sticker
		return [
			new ReturnMessage({
				chatId,
				content: processedMedia,
				options: {
					sendMediaAsSticker: true,
					stickerAuthor: bot?.nomeExibir || "ravena",
					stickerName,
					quotedMessageId
				}
			})
		];
	} catch (error) {
		logger.error(`Erro ao criar sticker (${stickerOptions.cropMode}):`, error);

		try {
			await message.origin.react("❌");
		} catch (reactError) {
			logger.error("Erro ao aplicar reação de erro:", reactError);
		}

		return new ReturnMessage({
			chatId,
			content: `❌ Deu ruim ao criar a figurinha. Tenta mandar outra imagem, vídeo ou áudio!`
		});
	}
}

/**
 * Processa automaticamente imagens/vídeos enviados para o PV, convertendo-os em stickers
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Object} group - Dados do grupo (será null para mensagens privadas)
 * @returns {Promise<boolean>} - Se a mensagem foi processada
 */
async function processAutoSticker(bot, message, group) {
	try {
		// Verifica se a mensagem é privada (não é de grupo)
		if (message.group) {
			return false;
		}

		// Verifica se o usuário está gerenciando algum grupo pelo PV
		if (bot.eventHandler?.commandHandler?.privateManagement?.[message.author]) {
			// O usuário está gerenciando um grupo pelo PV, não criar sticker automaticamente
			return false;
		}

		// Pula se não for mídia de imagem, vídeo ou GIF
		if (!["image", "video", "gif"].includes(message.type)) {
			return false;
		}

		logger.debug(
			`[processAutoSticker] Processando mídia automática para sticker no chat ${message.author}`
		);

		// Criar um nome para o sticker (pode ser o nome de quem enviou ou um padrão)
		const stickerName = message.authorName || "sticker";

		// Lazy loading: garante que o base64 esteja disponível antes de enviar
		let stickerContent = message.content;
		if (!stickerContent?.data && typeof message.downloadMedia === "function") {
			try {
				stickerContent = await message.downloadMedia();
			} catch (e) {
				logger.error("[processAutoSticker] Erro ao baixar mídia:", e);
				return false;
			}
		}
		if (!stickerContent?.data) {
			logger.warn("[processAutoSticker] Mídia sem dados, abortando");
			return false;
		}

		// Processa a mídia para o padrão de figurinha do WhatsApp (512x512, transparente, compactado, max 6s)
		let processedMedia = stickerContent;
		try {
			const processedBuffer = await processMediaToSquare(
				stickerContent,
				stickerContent.mimetype || message.type,
				"transparent"
			);
			processedMedia = {
				mimetype: "image/webp",
				data: processedBuffer.toString("base64"),
				filename: `autosticker-${Date.now()}.webp`,
				isMessageMedia: true
			};
		} catch (procErr) {
			logger.warn(
				"[processAutoSticker] Erro ao pré-processar sticker no padrão, usando mídia original:",
				procErr
			);
		}

		// Usar ReturnMessage para enviar o sticker
		const returnMessage = new ReturnMessage({
			chatId: message.author,
			content: processedMedia,
			options: {
				sendMediaAsSticker: true,
				stickerAuthor: bot?.nomeExibir || "ravena",
				stickerName,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});

		// Envia o sticker
		await bot.sendReturnMessages(returnMessage, group);

		logger.info(`[processAutoSticker] Sticker automático enviado para ${message.author}`);

		return true;
	} catch (error) {
		logger.error("Erro no processamento automático de sticker:", error);
		return false;
	}
}

// Criar array de comandos usando a classe Command
const STICKER_OPTIONS_DESC =
	"Cria uma figurinha (imagem, vídeo, GIF ou documento)! Opções: hq (alta resolução/FPS), longo (até 60s), q (centro), qc (topo), qb (base), qe (esticado), qi (IA), fh/inv (espelhar horizontal), fv (espelhar vertical), 90 (girar 90° horário), -90/270 (anti-horário). Também cria/extrai figurinhas com som.";

const commands = [
	new Command({
		name: "sticker",
		description: STICKER_OPTIONS_DESC,
		category: "stickers",
		group: "ssticker",
		needsMedia: true, // Verificará tanto mídia direta quanto mídia de mensagem citada
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),
	new Command({
		name: "figurinha",
		description: STICKER_OPTIONS_DESC,
		category: "stickers",
		group: "ssticker",
		needsMedia: true, // Verificará tanto mídia direta quanto mídia de mensagem citada
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),

	new Command({
		name: "s",
		description: STICKER_OPTIONS_DESC,
		category: "stickers",
		group: "ssticker",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),
	new Command({
		name: "fig",
		description: STICKER_OPTIONS_DESC,
		category: "stickers",
		group: "ssticker",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),
	new Command({
		name: "sqi",
		description:
			"Cria figurinha quadrada com corte inteligente via IA (atalho para !s qi; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqi",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "llm")
	}),
	new Command({
		name: "stickerqi",
		description:
			"Cria figurinha quadrada com corte inteligente via IA (atalho para !s qi; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqi",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "llm")
	}),
	new Command({
		name: "sq",
		description:
			"Cria figurinha quadrada cortada no centro (atalho para !s q; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sq",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "center")
	}),
	new Command({
		name: "stickerq",
		description:
			"Cria figurinha quadrada cortada no centro (atalho para !s q; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sq",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "center")
	}),
	new Command({
		name: "sqc",
		description:
			"Cria figurinha quadrada cortando no topo (atalho para !s qc; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqc",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "top")
	}),
	new Command({
		name: "stickerqc",
		description:
			"Cria figurinha quadrada cortando no topo (atalho para !s qc; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqc",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "top")
	}),

	new Command({
		name: "sqb",
		description:
			"Cria figurinha quadrada cortando na base (atalho para !s qb; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqb",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "bottom")
	}),
	new Command({
		name: "stickerqb",
		description:
			"Cria figurinha quadrada cortando na base (atalho para !s qb; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqb",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "bottom")
	}),
	// Comando para sticker esticado (sqe)
	new Command({
		name: "sqe",
		description:
			"Cria figurinha quadrada esticada sem cortar as bordas (atalho para !s qe; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqe",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "stretch")
	}),
	new Command({
		name: "stickerqe",
		description:
			"Cria figurinha quadrada esticada sem cortar as bordas (atalho para !s qe; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_sqe",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "stretch")
	}),
	new Command({
		name: "shq",
		description:
			"Cria figurinha em alta taxa de quadros e resolução (atalho para !s hq; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_shq",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "hq")
	}),
	new Command({
		name: "stickerhq",
		description:
			"Cria figurinha em alta taxa de quadros e resolução (atalho para !s hq; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_shq",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "hq")
	}),
	new Command({
		name: "slongo",
		description:
			"Cria figurinha de vídeo longa até 60s (atalho para !s longo; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_slongo",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "long")
	}),
	new Command({
		name: "stickerlongo",
		description:
			"Cria figurinha de vídeo longa até 60s (atalho para !s longo; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_slongo",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "long")
	}),
	new Command({
		name: "slongohq",
		description:
			"Cria figurinha de vídeo longa até 60s em alta qualidade (atalho para !s hq longo; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_slongohq",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "longhq")
	}),
	new Command({
		name: "stickerlongohq",
		description:
			"Cria figurinha de vídeo longa até 60s em alta qualidade (atalho para !s hq longo; aceita opções do !s)",
		category: "stickers",
		group: "ssticker_slongohq",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "longhq")
	}),
	new Command({
		name: "sa",
		description:
			"Transforma vídeo (ou áudio respondendo a figurinha) em figurinha com som (também aceita opções do !s)",
		category: "stickers",
		group: "sstickersound",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await audioStickerFromVideoCommand(bot, message, args, group)
	}),
	new Command({
		name: "saudio",
		description:
			"Transforma vídeo (ou áudio respondendo a figurinha) em figurinha com som (também aceita opções do !s)",
		category: "stickers",
		group: "sstickersound",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 5,
		cooldownPV: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await audioStickerFromVideoCommand(bot, message, args, group)
	})
];

const helper = {
	about:
		"Criação, recorte, transformações, corte inteligente por IA e conversão de figurinhas (stickers), incluindo stickers com som e documentos",
	implementation:
		"Processa imagens, vídeos, áudios e documentos (PNG, WebP, vídeo, áudio) com Sharp e FFmpeg. Comandos como !s e !sa aceitam argumentos combináveis (hq, longo, q, qc, qb, qe, qi, fh/inv, fv, 90, -90), além de criação e extração de figurinhas com som",
	tags: "sticker,figurinha,s,sa,saudio,fig,sq,sqi,shq,stickerhq,slongo,stickerlongo,slongohq,stickerlongohq,midia,recorte,whatsapp,som,audio,document",
	cmds: [
		{
			cmd: "!sticker",
			desc: "Cria uma figurinha (imagem, vídeo, GIF ou documento)! Opções: hq (alta resolução/FPS), longo (até 60s), q (centro), qc (topo), qb (base), qe (esticado), qi (IA), fh/inv (espelhar horizontal), fv (espelhar vertical), 90 (girar 90° horário), -90/270 (anti-horário). Também cria/extrai figurinhas com som.",
			usage: [
				"!s (com imagem, vídeo, GIF, documento ou em resposta)",
				"!s hq (alta resolução/FPS sem bordas transparentes)",
				"!s longo (preserva duração de vídeos longos até 60s)",
				"!s q / c / centro (corte quadrado no centro)",
				"!s qc / cima (corte quadrado no topo)",
				"!s qb / baixo (corte quadrado na base)",
				"!s qe / esticar (esticado para quadrado sem cortar)",
				"!s qi / ia (corte quadrado inteligente por IA)",
				"!s fh / inv / espelhar (inverte horizontalmente)",
				"!s fv (inverte verticalmente)",
				"!s 90 / horario (gira 90° no sentido horário)",
				"!s -90 / 270 / antihorario (gira 90° no sentido anti-horário)",
				"!s hq qc fh (combine livremente e adicione um nome no fim)",
				"[figurinha] -> [áudio ou documento de áudio] -> !s (cria sticker com som)",
				"!s (respondendo a uma figurinha extrai a mídia e o áudio original)"
			],
			category: "stickers"
		},
		{
			cmd: "!sa",
			desc: "Transforma vídeo (ou áudio respondendo a figurinha) em figurinha com som (também aceita opções do !s)",
			usage: [
				"!sa (na legenda do vídeo ou em resposta a um vídeo)",
				"!sa hq longo q (alta qualidade, até 60s e corte central)",
				"!sa qc fh 90 (combina corte, espelhamento e rotação)",
				"!saudio"
			],
			category: "stickers"
		},
		{
			cmd: "!shq",
			desc: "Cria figurinha em alta taxa de quadros e resolução (atalho para !s hq; aceita opções do !s)",
			usage: ["!shq (com imagem/vídeo ou em resposta)", "!shq qc", "!stickerhq"],
			category: "stickers"
		},
		{
			cmd: "!slongo",
			desc: "Cria figurinha de vídeo longa até 60s (atalho para !s longo; aceita opções do !s)",
			usage: ["!slongo (com vídeo/GIF ou em resposta)", "!slongo q", "!stickerlongo"],
			category: "stickers"
		},
		{
			cmd: "!slongohq",
			desc: "Cria figurinha de vídeo longa até 60s em alta qualidade (atalho para !s hq longo; aceita opções do !s)",
			usage: ["!slongohq (com vídeo/GIF ou em resposta)", "!slongohq qc", "!stickerlongohq"],
			category: "stickers"
		},
		{
			cmd: "!sqi",
			desc: "Cria figurinha quadrada com enquadramento inteligente via IA (atalho para !s qi; aceita opções do !s)",
			usage: ["!sqi (com imagem ou em resposta)", "!sqi hq fh", "!stickerqi"],
			category: "stickers"
		},
		{
			cmd: "!sq",
			desc: "Cria figurinha quadrada cortada no centro (atalho para !s q; aceita opções do !s)",
			usage: ["!sq (com imagem/vídeo ou em resposta)", "!sq hq", "!stickerq"],
			category: "stickers"
		},
		{
			cmd: "!sqc",
			desc: "Cria figurinha quadrada cortando no topo (atalho para !s qc; aceita opções do !s)",
			usage: ["!sqc (com imagem/vídeo ou em resposta)", "!sqc hq", "!stickerqc"],
			category: "stickers"
		},
		{
			cmd: "!sqb",
			desc: "Cria figurinha quadrada cortando na base (atalho para !s qb; aceita opções do !s)",
			usage: ["!sqb (com imagem/vídeo ou em resposta)", "!sqb hq", "!stickerqb"],
			category: "stickers"
		},
		{
			cmd: "!sqe",
			desc: "Cria figurinha quadrada esticada sem cortar as bordas (atalho para !s qe; aceita opções do !s)",
			usage: ["!sqe (com imagem/vídeo ou em resposta)", "!sqe 90", "!stickerqe"],
			category: "stickers"
		}
	]
};

module.exports = {
	helper,
	commands,
	processAutoSticker,
	parseStickerArgs,
	processMediaToSquare,
	getLLMCropPercentage
};
