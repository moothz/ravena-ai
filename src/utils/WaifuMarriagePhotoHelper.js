const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const Logger = require("./Logger");
const Database = require("./Database");
const LLMService = require("../services/LLMService");
const ProfilePictureHelper = require("./ProfilePictureHelper");
const bonsaiModule = require("../functions/BonsaiCommands");

const logger = new Logger("waifu-marriage-photo");
const database = Database.getInstance();

const DB_NAME = "waifu_marriage_photos";
const WAIFULETES_BASE_URL = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";

// Inicializa tabela SQLite para persistência e metadados das fotos de casamento
database.getSQLiteDb(
	DB_NAME,
	`
	CREATE TABLE IF NOT EXISTS waifu_marriage_photos (
		character_id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		user_name TEXT,
		photo_path TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_waifu_marriage_user ON waifu_marriage_photos(user_id);
	`
);

/**
 * Retorna o diretório base para salvar as fotos de casamento
 * @returns {string}
 */
function getMarriagesDir() {
	return path.join(database.databasePath, "marriages");
}

/**
 * Garante que o diretório de fotos de casamento exista
 */
async function ensureMarriagesDir() {
	const dir = getMarriagesDir();
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch (e) {
		logger.error("Erro ao criar diretório de fotos de casamento:", e);
	}
	return dir;
}

/**
 * Retorna o caminho do arquivo de borda oficial
 * @returns {string}
 */
function getBorderPath() {
	const primaryPath = path.join(database.databasePath, "assets", "marriage_border.png");
	if (fsSync.existsSync(primaryPath)) {
		return primaryPath;
	}
	const fallbackPath = path.join(process.cwd(), "data", "assets", "marriage_border.png");
	if (fsSync.existsSync(fallbackPath)) {
		return fallbackPath;
	}
	return primaryPath;
}

/**
 * Baixa o buffer da imagem de um personagem resolvendo URLs locais/relativas
 * @param {string} imageUrl
 * @returns {Promise<Buffer|null>}
 */
async function downloadCharacterImageBuffer(imageUrl) {
	if (!imageUrl) return null;
	try {
		let resolvedUrl = imageUrl;
		if (resolvedUrl.startsWith("/") || resolvedUrl.includes("localhost:")) {
			const pathPart = resolvedUrl.replace(/^https?:\/\/[^/]+/, "");
			resolvedUrl = `${WAIFULETES_BASE_URL}${pathPart.startsWith("/") ? "" : "/"}${pathPart}`;
		}

		const response = await axios.get(resolvedUrl, {
			responseType: "arraybuffer",
			timeout: 15000
		});
		return Buffer.from(response.data);
	} catch (err) {
		logger.warn(`Falha ao baixar imagem do personagem (${imageUrl}):`, err.message);
		return null;
	}
}

/**
 * Solicita à IA uma descrição detalhada da personagem casada.
 * Se der erro ou falhar, retorna o buffer original para fallback.
 * @param {Object} character
 * @returns {Promise<{ success: boolean, description?: string, originalBase64?: string, fallback: "text"|"original_image" }>}
 */
async function describeCharacter(character) {
	if (!character || !character.imageUrl) {
		return { success: false, fallback: "text" };
	}

	const imageBuffer = await module.exports.downloadCharacterImageBuffer(character.imageUrl);
	if (!imageBuffer) {
		return { success: false, fallback: "text" };
	}

	const originalBase64 = imageBuffer.toString("base64");

	try {
		const llmService = LLMService.getInstance();
		const response = await llmService.getCompletion({
			prompt:
				"Analyze this anime character image and provide a concise, objective description of their physical and visual features (gender, hair style/color, eyes, facial traits, key visual characteristics, signature outfit/style) for use in an AI image generation prompt. Be brief, specific and direct. Answer in English.",
			systemContext:
				"You are an expert at describing anime characters for image generation prompts.",
			image: originalBase64,
			maxTokens: 300,
			priority: 5,
			timeout: 30000
		});

		if (
			!response ||
			typeof response !== "string" ||
			response.trim().length === 0 ||
			response.includes("Não foi poss") ||
			response.includes("Ocorreu um erro")
		) {
			logger.warn(
				`Descrição da personagem via LLM retornou resposta inválida para ${character.id}. Fallback para imagem original.`
			);
			return { success: false, fallback: "original_image", originalBase64 };
		}

		return {
			success: true,
			description: response.trim(),
			originalBase64
		};
	} catch (err) {
		logger.warn(
			`Erro ao solicitar descrição da personagem à IA (${character.id}): ${err.message}. Fallback para imagem original.`
		);
		return { success: false, fallback: "original_image", originalBase64 };
	}
}

/**
 * Solicita à IA uma descrição física da foto de perfil do autor
 * @param {Object} bot
 * @param {string} userId
 * @param {Object} message
 * @returns {Promise<string|null>}
 */
async function describeUser(bot, userId, message) {
	try {
		// Prioriza o userId passado explicitamente (já validado pelo comando de casamento)
		let targetJid = userId || null;
		if (!targetJid && message) {
			targetJid =
				message.originReaction?.senderId ||
				message.authorAlt ||
				message.author ||
				message.sender ||
				message.from;
		}

		if (targetJid && typeof targetJid === "object") {
			targetJid =
				targetJid._serialized ||
				targetJid.id?._serialized ||
				targetJid.id ||
				targetJid.user ||
				String(targetJid);
		}

		if (!targetJid || !bot) return null;

		targetJid = String(targetJid).trim();

		// Normaliza removendo sufixos de device (ex: 5511...:2@s.whatsapp.net -> 5511...@s.whatsapp.net)
		if (targetJid.includes(":") && targetJid.includes("@")) {
			const [userPart, domain] = targetJid.split("@");
			const cleanUser = userPart.split(":")[0];
			targetJid = `${cleanUser}@${domain}`;
		}

		// Trava de segurança: NUNCA usar avatar do próprio bot como descrição do usuário
		if (ProfilePictureHelper.isBotJid(bot, targetJid)) {
			logger.warn(
				`[describeUser] O JID resolvido (${targetJid}) pertence ao próprio bot. Abortando descrição de avatar.`
			);
			return null;
		}

		const profileMedia = await ProfilePictureHelper.fetchUserProfilePictureMedia(bot, targetJid);
		if (!profileMedia || !profileMedia.data) return null;

		const llmService = LLMService.getInstance();
		const response = await llmService.getCompletion({
			prompt:
				"Descreva de forma concisa e objetiva as características físicas e visuais da pessoa ou personagem nesta foto de perfil (gênero aparente, traços faciais, estilo e cor do cabelo, tom de pele, roupas e acessórios) para ser usada em um prompt de geração de imagem. Seja breve e direto. Responda em inglês.",
			systemContext:
				"You are an assistant describing human avatars for image generation prompts. Respond in English.",
			image: profileMedia.data,
			maxTokens: 250,
			priority: 5,
			timeout: 30000
		});

		if (
			response &&
			typeof response === "string" &&
			response.trim().length > 0 &&
			!response.includes("Não foi poss") &&
			!response.includes("Ocorreu um erro")
		) {
			return response.trim();
		}
	} catch (err) {
		logger.warn("Não foi possível obter descrição da foto de perfil via LLM:", err.message);
	}
	return null;
}

/**
 * Monta o prompt de geração para o casamento
 * @param {Object} character
 * @param {string} characterDesc
 * @param {string|null} userDesc
 * @returns {string}
 */
function buildMarriagePrompt(character, characterDesc, userDesc) {
	const rarity = (character.baseRarity || character.rarity || "COMMON").toUpperCase();

	let rarityAddition = "";
	switch (rarity) {
		case "COMMON":
			rarityAddition = "Joyful bright smiles, happy facial expressions, warm cheerful mood.";
			break;
		case "RARE":
			rarityAddition =
				"Breathtaking romantic sunset, golden hour lighting, vibrant warm twilight sky, romantic evening ambiance.";
			break;
		case "EPIC":
			rarityAddition =
				"Romantic twilight glow, floating gentle flower petals drifting in the wind, soft evening light, enchanting romantic aura.";
			break;
		case "LEGENDARY":
			rarityAddition =
				"Magical ethereal glow, radiant golden sparkle highlights, magnificent festive fireworks bursting across the sky, legendary majestic atmosphere.";
			break;
		case "UNCOMMON":
		default:
			rarityAddition = "";
			break;
	}

	const charReference = character.name
		? `the character '${character.name}'${character.series ? ` from '${character.series}'` : ""}`
		: "the bride";

	const partnerDesc = userDesc ? `(${userDesc})` : "in an elegant formal wedding suit";

	const prompt =
		`Outdoor open-air wedding ceremony under the open sky, scenic romantic wedding altar decorated with elegant blooming flowers and floral arrangements. The newlyweds are celebrating their marriage: ${charReference} (${characterDesc}) alongside their loving partner ${partnerDesc}. Both are happily dressed in traditional formal wedding attire (exquisite wedding dress and formal suit or tuxedo). ${rarityAddition} Masterpiece anime art style, clean linework, vibrant rich colors, expressive romantic facial expressions, highly detailed, 8k resolution, cinematic lighting, textless, no text, no watermark, no captions, no words, no letters, no subtitles.`.trim();

	return prompt;
}

/**
 * Aplica a borda marriage_border.png sobre o buffer da imagem gerada
 * @param {Buffer} imageBuffer
 * @returns {Promise<Buffer>}
 */
async function compositeMarriageBorder(imageBuffer) {
	const borderPath = getBorderPath();
	if (!fsSync.existsSync(borderPath)) {
		logger.warn(`Arquivo de borda não encontrado em ${borderPath}, mantendo imagem sem borda.`);
		return imageBuffer;
	}

	try {
		const meta = await sharp(imageBuffer).metadata();
		const width = meta.width || 1024;
		const height = meta.height || 1024;

		const resizedBorder = await sharp(borderPath).resize(width, height).toBuffer();

		return await sharp(imageBuffer)
			.composite([{ input: resizedBorder, blend: "over" }])
			.jpeg({ quality: 90 })
			.toBuffer();
	} catch (err) {
		logger.error("Erro ao aplicar borda na imagem de casamento:", err);
		return imageBuffer;
	}
}

/**
 * Gera a imagem do casamento com BonsaiAPI, aplica a borda e salva localmente
 * @param {Object} bot
 * @param {Object} message
 * @param {Object} character
 * @param {string} userId
 * @param {string} userName
 * @returns {Promise<{ success: boolean, media?: Object, fallback?: "text"|"original_image", originalBase64?: string, photoPath?: string }>}
 */
async function generateAndSaveMarriageImage(bot, message, character, userId, userName) {
	try {
		// 1. Obter descrição da personagem pela LLM
		const charDescResult = await module.exports.describeCharacter(character);
		if (!charDescResult.success) {
			return {
				success: false,
				fallback: charDescResult.fallback,
				originalBase64: charDescResult.originalBase64
			};
		}

		// 2. Obter descrição do autor pela LLM
		const userDesc = await module.exports.describeUser(bot, userId, message);

		// 3. Montar prompt com regras de raridade
		const prompt = module.exports.buildMarriagePrompt(
			character,
			charDescResult.description,
			userDesc
		);
		logger.info(`[generateAndSaveMarriageImage] Prompt gerado: ${prompt.substring(0, 100)}...`);

		// 4. Invocar BonsaiAPI
		if (!bonsaiModule || typeof bonsaiModule.generateImage !== "function") {
			logger.warn("Módulo BonsaiCommands não disponível.");
			return { success: false, fallback: "text" };
		}

		const mockMessage = {
			author: userId || "SYSTEM",
			authorName: userName || "Sistema",
			content: prompt,
			origin: {
				getQuotedMessage: () => Promise.resolve(null),
				react: async () => {}
			}
		};

		const maxAttempts = 3;
		let bonsaiResult = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				bonsaiResult = await bonsaiModule.generateImage(
					bot,
					mockMessage,
					prompt,
					{ filters: { nsfw: false } },
					true,
					{ skipNSFW: true, isProgrammatic: true }
				);

				if (bonsaiResult && bonsaiResult.content && bonsaiResult.content.data) {
					logger.info(
						`[generateAndSaveMarriageImage] Imagem gerada com sucesso via Bonsai na tentativa ${attempt}/${maxAttempts}`
					);
					break;
				}
				logger.warn(
					`[generateAndSaveMarriageImage] Bonsai não retornou mídia válida na tentativa ${attempt}/${maxAttempts}`
				);
			} catch (err) {
				logger.warn(
					`[generateAndSaveMarriageImage] Erro na tentativa ${attempt}/${maxAttempts} do Bonsai: ${err.message}`
				);
			}

			if (attempt < maxAttempts) {
				logger.info(
					`[generateAndSaveMarriageImage] Aguardando 1.5s antes da tentativa ${attempt + 1}...`
				);
				await new Promise((resolve) => setTimeout(resolve, 1500));
			}
		}

		if (!bonsaiResult || !bonsaiResult.content || !bonsaiResult.content.data) {
			logger.warn(
				`Bonsai não retornou mídia válida para casamento de ${character.id} após ${maxAttempts} tentativas. Fallback para texto.`
			);
			return { success: false, fallback: "text" };
		}

		// 5. Aplicar borda marriage_border.png
		const rawBuffer = Buffer.from(bonsaiResult.content.data, "base64");
		const framedBuffer = await module.exports.compositeMarriageBorder(rawBuffer);

		// 6. Salvar imagem no diretório permanente
		await ensureMarriagesDir();
		const photoPath = path.join(getMarriagesDir(), `${character.id}.jpg`);
		await fs.writeFile(photoPath, framedBuffer);
		logger.info(`[generateAndSaveMarriageImage] Foto de casamento salva em: ${photoPath}`);

		// 7. Salvar/Atualizar no banco de dados SQLite
		const now = Date.now();
		try {
			await database.dbRun(
				DB_NAME,
				`
				INSERT INTO waifu_marriage_photos (character_id, user_id, user_name, photo_path, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(character_id) DO UPDATE SET
					user_id = excluded.user_id,
					user_name = excluded.user_name,
					photo_path = excluded.photo_path,
					updated_at = excluded.updated_at
				`,
				[character.id, userId, userName, photoPath, now, now]
			);
		} catch (dbErr) {
			logger.error("Erro ao registrar foto de casamento no SQLite:", dbErr);
		}

		// 8. Criar objeto de mídia do bot
		let mediaObj = null;
		if (bot && typeof bot.createMedia === "function") {
			mediaObj = await bot.createMedia(photoPath, "image/jpeg").catch(() => null);
		}

		if (!mediaObj) {
			mediaObj = {
				data: framedBuffer.toString("base64"),
				mimetype: "image/jpeg",
				isMessageMedia: true
			};
		}

		return {
			success: true,
			media: mediaObj,
			photoPath
		};
	} catch (error) {
		logger.error("Erro durante a geração de imagem de casamento:", error);
		return { success: false, fallback: "text" };
	}
}

/**
 * Consulta a foto de casamento salva no disco / SQLite
 * @param {string} characterId
 * @returns {Promise<{ exists: boolean, photoPath?: string, record?: Object }>}
 */
async function getMarriagePhoto(characterId) {
	if (!characterId) return { exists: false };

	const photoPath = path.join(getMarriagesDir(), `${characterId}.jpg`);
	const fileExists = fsSync.existsSync(photoPath);

	let record = null;
	try {
		record = await database.dbGet(
			DB_NAME,
			"SELECT * FROM waifu_marriage_photos WHERE character_id = ?",
			[characterId]
		);
	} catch (e) {
		logger.warn("Erro ao consultar registro de foto no SQLite:", e.message);
	}

	if (fileExists) {
		return { exists: true, photoPath, record };
	}

	return { exists: false, record };
}

/**
 * Remove a foto de casamento do disco e do SQLite (usado no divórcio)
 * @param {string} characterId
 */
async function removeMarriagePhoto(characterId) {
	if (!characterId) return;

	try {
		const photoPath = path.join(getMarriagesDir(), `${characterId}.jpg`);
		if (fsSync.existsSync(photoPath)) {
			await fs.unlink(photoPath).catch(() => {});
			logger.info(`Foto de casamento removida do disco: ${photoPath}`);
		}
	} catch (e) {
		logger.warn(`Erro ao excluir foto de casamento do disco (${characterId}):`, e.message);
	}

	try {
		await database.dbRun(DB_NAME, "DELETE FROM waifu_marriage_photos WHERE character_id = ?", [
			characterId
		]);
	} catch (dbErr) {
		logger.warn(`Erro ao deletar registro de casamento no SQLite (${characterId}):`, dbErr.message);
	}
}

module.exports = {
	getMarriagesDir,
	ensureMarriagesDir,
	getBorderPath,
	downloadCharacterImageBuffer,
	describeCharacter,
	describeUser,
	buildMarriagePrompt,
	compositeMarriageBorder,
	generateAndSaveMarriageImage,
	getMarriagePhoto,
	removeMarriagePhoto
};
