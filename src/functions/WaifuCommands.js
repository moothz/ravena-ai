const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("waifu-commands");

// ─── Configurações da API ───────────────────────────────────────────────────
const WAIFULETES_URL = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";
const WAIFULETES_KEY = process.env.WAIFULETES_API_KEY || "waifuletes_secret_token_123456";

const api = axios.create({
	baseURL: WAIFULETES_URL,
	headers: {
		Authorization: `Bearer ${WAIFULETES_KEY}`,
		"Content-Type": "application/json"
	},
	timeout: 15000
});

// Janela de claim: 120 segundos (2 minutos)
const CLAIM_WINDOW_MS = 120 * 1000;

// Cache em memória da janela de claim (120s) por grupo
// Map<groupId, { characterId: string, characterName: string, expiresAt: number }>
const pendingClaims = new Map();

// Mapeamentos visuais de Raridade
const RARITY_EMOJI = {
	COMMON: "⚪",
	UNCOMMON: "🟢",
	RARE: "🔵",
	EPIC: "🟣",
	LEGENDARY: "⭐"
};

const RARITY_LABEL = {
	COMMON: "Comum",
	UNCOMMON: "Incomum",
	RARE: "Raro",
	EPIC: "Épico",
	LEGENDARY: "Lendário"
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getUserId(message) {
	return message.author;
}

function getGroupId(message) {
	return message.group ?? message.author;
}

function getUserName(message) {
	return message.authorName || (message.author ? message.author.split("@")[0] : "Jogador");
}

async function ensureUser(userId, groupId, name) {
	try {
		await api.post("/user/ensure", {
			userId,
			groupId,
			name,
			platform: "WHATSAPP"
		});
	} catch (e) {
		logger.debug("Tentativa de auto-cadastro ensureUser:", e.message);
	}
}

function formatRemainingSeconds(seconds) {
	if (!seconds || seconds <= 0) return "0s";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${m}min`;
	if (m > 0) return `${m}min ${s}s`;
	return `${s}s`;
}

/**
 * Baixa a imagem do personagem pela porta exposta da API e retorna em Base64
 * @param {string} imageUrl
 * @returns {Promise<string|null>}
 */
async function downloadImageAsBase64(imageUrl) {
	if (!imageUrl) return null;
	try {
		let resolvedUrl = imageUrl;
		// Se a URL apontar para localhost ou vier relativa, substitui para a base configurada
		if (resolvedUrl.startsWith("/") || resolvedUrl.includes("localhost:")) {
			const pathPart = resolvedUrl.replace(/^https?:\/\/[^/]+/, "");
			resolvedUrl = `${WAIFULETES_URL}${pathPart.startsWith("/") ? "" : "/"}${pathPart}`;
		}

		const response = await axios.get(resolvedUrl, {
			responseType: "arraybuffer",
			timeout: 10000
		});
		return Buffer.from(response.data, "binary").toString("base64");
	} catch (err) {
		logger.warn(`Falha ao baixar imagem de waifu (${imageUrl}):`, err.message);
		return null;
	}
}

/**
 * Tratamento padronizado de erros retornados pela API Waifuletes
 * @param {Error} err
 * @param {string} chatId
 * @param {string} defaultMsg
 * @returns {ReturnMessage}
 */
function handleApiError(err, chatId, defaultMsg) {
	const apiErr = err.response?.data?.error;
	if (apiErr?.code === "COOLDOWN_ACTIVE") {
		return new ReturnMessage({
			chatId,
			content: `⏳ *Aguarde!* ${apiErr.message || `Você precisa esperar ${formatRemainingSeconds(apiErr.remainingSeconds)}.`}`
		});
	}

	const customMsgs = {
		LOCK_EXPIRED: "⌛ A janela de 120 segundos para casar expirou!",
		CHARACTER_ALREADY_CLAIMED: "🚫 Este personagem já foi reivindicado por outro jogador!",
		CHARACTER_NOT_IN_HAREM: "❓ Este personagem não faz parte do seu harém.",
		WISHLIST_LIMIT_REACHED: "⚠️ Sua wishlist está cheia (máximo de 30). Remova um item antes.",
		CHARACTER_NOT_FOUND: "🔍 Personagem não encontrado. Verifique o ID informado.",
		USER_NOT_FOUND: "👤 Usuário não cadastrado ainda. Use *!mu-roll* para começar!"
	};

	const message = (apiErr?.code && customMsgs[apiErr.code]) || apiErr?.message || defaultMsg;
	logger.error("Erro na chamada Waifuletes:", apiErr || err.message);
	return new ReturnMessage({ chatId, content: `❌ ${message}` });
}

// ─── Handlers de Comandos ───────────────────────────────────────────────────

/**
 * Cria função de roll com ou sem filtro de gênero
 * @param {"MALE" | "FEMALE" | undefined} genderFilter
 */
function makeRollHandler(genderFilter) {
	return async function rollWaifu(bot, message) {
		const chatId = message.group ?? message.author;
		const userId = getUserId(message);
		const groupId = getGroupId(message);
		const name = getUserName(message);

		try {
			const payload = {
				userId,
				groupId,
				name,
				platform: "WHATSAPP",
				...(genderFilter && { gender: genderFilter })
			};

			const { data } = await api.post("/roll", payload);
			const { character, available, isOwner, owner, keyProgress, kakeraValue } = data.data;

			const rarity = character.rarity || character.baseRarity || "COMMON";
			const emojiRarity = RARITY_EMOJI[rarity] || "⚪";
			const labelRarity = RARITY_LABEL[rarity] || rarity;

			let text = `🎲 *${character.name}* — _${character.series}_\n`;
			text += `${emojiRarity} *[${labelRarity}]*\n`;

			if (character.description) {
				const desc =
					character.description.length > 180
						? `${character.description.substring(0, 180)}...`
						: character.description;
				text += `\n_${desc}_\n`;
			}
			text += "\n";

			if (available) {
				// Salva o claim temporário no grupo por 120 segundos
				pendingClaims.set(groupId, {
					characterId: character.id,
					characterName: character.name,
					expiresAt: Date.now() + CLAIM_WINDOW_MS
				});
				setTimeout(() => {
					const cur = pendingClaims.get(groupId);
					if (cur && cur.characterId === character.id) {
						pendingClaims.delete(groupId);
					}
				}, CLAIM_WINDOW_MS);

				text += `💍 *LIVRE!* Digite \`!mu-casar\` ou \`!mu-casar ${character.id}\` em até 120s para casar!`;
			} else if (isOwner) {
				const keys = keyProgress?.currentKeys ?? 1;
				text += `✨ *Você rolou seu próprio personagem!*\n🔑 Chaves acumuladas: *${keys}/10*`;
				if (keyProgress?.becameSoulmateNow) {
					text += `\n\n💖 *PARABÉNS! ${character.name} agora é oficialmente sua SOULMATE permanente!*`;
				}
			} else {
				text += `🔒 Já pertence a: *${owner?.name || "Outro jogador"}*`;
				if (kakeraValue) {
					text += `\n💜 Valor em cristal: *${kakeraValue} Zinthos*`;
				}
			}

			// Tenta baixar a imagem e enviar com mídia
			const imageBase64 = await downloadImageAsBase64(character.imageUrl);
			if (imageBase64) {
				return new ReturnMessage({
					chatId,
					content: {
						mimetype: "image/jpeg",
						data: imageBase64,
						filename: "waifu.jpg",
						isMessageMedia: true
					},
					options: {
						caption: text
					}
				});
			}

			return new ReturnMessage({ chatId, content: text });
		} catch (err) {
			return handleApiError(
				err,
				chatId,
				"Erro ao realizar sorteio de personagem. Tente novamente."
			);
		}
	};
}

const rollAny = makeRollHandler(undefined);
const rollMale = makeRollHandler("MALE");
const rollFemale = makeRollHandler("FEMALE");

/**
 * Reivindica casamento com personagem sorteado
 */
async function casarWaifu(bot, message, args) {
	const chatId = message.group ?? message.author;
	const groupId = getGroupId(message);
	const userId = getUserId(message);
	const name = getUserName(message);

	let characterId = args[0];
	if (!characterId) {
		const pending = pendingClaims.get(groupId);
		if (!pending || Date.now() > pending.expiresAt) {
			return new ReturnMessage({
				chatId,
				content:
					"❌ Nenhum personagem livre disponível para casamento agora. Use *!mu-roll* primeiro!",
				options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
			});
		}
		characterId = pending.characterId;
	}

	try {
		const { data } = await api.post("/marry", {
			userId,
			groupId,
			characterId,
			name,
			platform: "WHATSAPP"
		});

		pendingClaims.delete(groupId);
		const { character, keys, isSoulmate, kakeraBalance } = data.data;

		let text = `💍 *Parabéns!* Você se casou com *${character.name}*! 🎉\n`;
		text += `🔑 Chaves: *${keys}/10*\n`;
		text += `💜 Saldo atual: *${kakeraBalance} Zinthos*`;
		if (isSoulmate) {
			text += `\n💖 *${character.name} é sua Soulmate definitiva!*`;
		}

		return new ReturnMessage({
			chatId,
			content: text,
			options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao realizar casamento.");
	}
}

/**
 * Divorcia personagem e resgata Zinthos
 */
async function divorciarWaifu(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content: "❌ Informe o ID do personagem para divórcio.\nExemplo: `!mu-divorciar rem-re-zero`"
		});
	}

	const characterId = args[0].trim();

	try {
		const { data } = await api.post("/divorce", { userId, characterId });
		const { character, refundedKakera, keysLost, newKakeraBalance } = data.data;

		let text = `💔 *Divórcio concluído!*\nVocê se separou de *${character.name}*.\n`;
		text += `💜 Reembolso: *+${refundedKakera} Zinthos* (perdidas ${keysLost} chaves)\n`;
		text += `💰 Novo saldo: *${newKakeraBalance} Zinthos*`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao processar divórcio.");
	}
}

/**
 * Dá like em um personagem
 */
async function likeWaifu(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content: "❌ Informe o ID do personagem para curtir.\nExemplo: `!mu-like rem-re-zero`"
		});
	}

	const characterId = args[0].trim();

	try {
		const { data } = await api.post("/like", { userId, characterId });
		const { name, likeCount } = data.data;

		return new ReturnMessage({
			chatId,
			content: `❤️ Você curtiu *${name}*! Total de curtidas: *${likeCount}*`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao curtir personagem.");
	}
}

/**
 * Resgata recompensa diária de Zinthos
 */
async function diariosKakera(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const name = getUserName(message);

	try {
		const { data } = await api.post("/kakera/daily", { userId, groupId, name });
		const { amount, currencyEmoji, newBalance, nextDailyAt } = data.data;

		const nextDate = new Date(nextDailyAt);
		const formattedDate = nextDate.toLocaleString("pt-BR", {
			hour: "2-digit",
			minute: "2-digit",
			day: "2-digit",
			month: "2-digit"
		});

		let text = `${currencyEmoji || "💜"} *Recompensa Diária Coletada!*\n\n`;
		text += `🎁 Você recebeu: *+${amount} Zinthos*\n`;
		text += `💰 Saldo total: *${newBalance} Zinthos*\n`;
		text += `⏰ Próximo resgate: *${formattedDate}*`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao resgatar recompensa diária.");
	}
}

/**
 * Consulta saldo de Zinthos
 */
async function saldoKakera(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/kakera/${userId}`);
		const balance = data.data.balance ?? 0;

		return new ReturnMessage({
			chatId,
			content: `💜 *Seu Saldo:* *${balance} Zinthos*`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar saldo.");
	}
}

/**
 * Lista o harém do usuário de forma paginada
 */
async function verHarem(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	const page =
		parseInt(
			args.find((a) => /^\d+$/.test(a)),
			10
		) || 1;
	const limit = 15;

	try {
		const { data } = await api.get(`/harem/${userId}`, {
			params: { page, limit, sort: "keys" }
		});

		const haremData = data.data;
		const entries = haremData.data || [];
		const total = haremData.total || 0;
		const totalPages = haremData.totalPages || 1;

		if (entries.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"👰 *Seu Harém está vazio!* Use *!mu-roll* para encontrar e casar com waifus e husbandos."
			});
		}

		let text = `👰 *Seu Harém* (Total: ${total} | Pág ${page}/${totalPages}):\n\n`;

		entries.forEach((item, index) => {
			const char = item.character;
			const pos = (page - 1) * limit + index + 1;
			const fav = item.isFavorite ? "⭐ " : "";
			const sm = item.keys >= 10 ? " 💖" : "";
			const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";

			text += `${pos}. ${fav}${emojiRarity} *${char.name}*${sm} — _${char.series}_\n`;
			text += `   ↳ ID: \`${char.id}\` | 🔑 *${item.keys}/10*\n`;
		});

		if (page < totalPages) {
			text += `\n_Digite \`!mu-harem ${page + 1}\` para a próxima página._`;
		}

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar harém.");
	}
}

/**
 * Consulta perfil do usuário
 */
async function verPerfil(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/user/${userId}`);
		const user = data.data;

		const haremCount = user._count?.harem ?? 0;
		const soulmateCount = user._count?.soulmates ?? 0;
		const wishlistCount = user._count?.wishlist ?? 0;
		const favoriteChar = user.harem?.[0]?.character;

		let text = `🎮 *Perfil de ${user.name}*\n\n`;
		text += `💜 Zinthos: *${user.kakera}*\n`;
		text += `👰 Harém: *${haremCount} personagens*\n`;
		text += `💖 Soulmates: *${soulmateCount}*\n`;
		text += `🌟 Wishlist: *${wishlistCount}/30*\n`;

		if (favoriteChar) {
			text += `⭐ Waifu Favorita: *${favoriteChar.name}* (${favoriteChar.series})\n`;
		}

		text += `📅 No jogo desde: *${new Date(user.createdAt).toLocaleDateString("pt-BR")}*`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao buscar perfil.");
	}
}

/**
 * Consulta lista de desejos (Wishlist)
 */
async function verWishlist(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/wishlist/${userId}`);
		const wishlist = data.data || [];

		if (wishlist.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"🌟 *Sua Wishlist está vazia!*\nAdicione personagens com `!mu-desejar <id>` para aumentar suas chances de roll!"
			});
		}

		let text = `🌟 *Sua Lista de Desejos* (${wishlist.length}/30):\n\n`;
		wishlist.forEach((item, idx) => {
			const char = item.character;
			const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";
			text += `${idx + 1}. ${emojiRarity} *${char.name}* — _${char.series}_\n   ↳ ID: \`${char.id}\`\n`;
		});

		text += `\n_Para remover: \`!mu-removerdesejo <id>\`_`;
		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar wishlist.");
	}
}

/**
 * Adiciona personagem à wishlist
 */
async function adicionarDesejo(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const name = getUserName(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o ID do personagem para adicionar à Wishlist.\nExemplo: `!mu-desejar rem-re-zero`\nUse `!mu-personagens <nome>` para buscar o ID."
		});
	}

	const characterId = args[0].trim();

	try {
		await ensureUser(userId, groupId, name);
		const { data } = await api.post("/wishlist", { userId, characterId });
		return new ReturnMessage({
			chatId,
			content: `🌟 ${data.data.message || "Personagem adicionado à Wishlist com sucesso!"}`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao adicionar à wishlist.");
	}
}

/**
 * Remove personagem da wishlist
 */
async function removerDesejo(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o ID do personagem para remover da Wishlist.\nExemplo: `!mu-removerdesejo rem-re-zero`"
		});
	}

	const characterId = args[0].trim();

	try {
		await api.delete(`/wishlist/${userId}/${characterId}`);
		return new ReturnMessage({
			chatId,
			content: `🗑️ Personagem \`${characterId}\` removido da sua Wishlist.`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao remover da wishlist.");
	}
}

/**
 * Define personagem favorito em destaque
 */
async function definirFavorita(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o ID do personagem do seu harém para definir como favorito.\nExemplo: `!mu-favorito rem-re-zero`"
		});
	}

	const characterId = args[0].trim();

	try {
		const { data } = await api.patch(`/harem/${userId}/${characterId}/favorite`);
		return new ReturnMessage({
			chatId,
			content: `⭐ *${data.data.characterName || characterId}* foi definida como sua waifu favorita em destaque!`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao definir favorito.");
	}
}

/**
 * Lista todos os Soulmates (10+ chaves) do jogador
 */
async function verSoulmates(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/soulmates/${userId}`);
		const soulmates = data.data || [];

		if (soulmates.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"💖 *Você ainda não possui Soulmates!*\nRolar seus próprios personagens repetidos acumula chaves. Ao atingir 10 chaves, ela se torna sua Soulmate permanente."
			});
		}

		let text = `💖 *Seus Soulmates* (${soulmates.length}):\n\n`;
		soulmates.forEach((sm, idx) => {
			const char = sm.character;
			text += `${idx + 1}. 💖 *${char.name}* — _${char.series}_\n`;
			if (sm.alias) text += `   ↳ Apelido: "${sm.alias}"\n`;
			if (sm.note) text += `   ↳ Nota: _${sm.note}_\n`;
		});

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar soulmates.");
	}
}

/**
 * Exibe ranking global de jogadores por saldo de Zinthos
 */
async function verRanking(bot, message, args) {
	const chatId = message.group ?? message.author;
	const limit = Math.min(parseInt(args[0], 10) || 10, 20);

	try {
		const { data } = await api.get("/leaderboard/users", { params: { limit } });
		const topRich = data.data?.topRich || [];

		if (topRich.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "🏆 Nenhum jogador registrado no ranking ainda."
			});
		}

		const medals = ["🥇", "🥈", "🥉"];
		let text = `🏆 *Top ${topRich.length} Jogadores de Zinthos:*\n\n`;

		topRich.forEach((user, idx) => {
			const pos = medals[idx] || `${idx + 1}.`;
			text += `${pos} *${user.name}* — 💜 *${user.kakera}* Zinthos\n`;
			text += `   ↳ 👰 Harém: ${user._count?.harem ?? 0} | 💖 Soulmates: ${user._count?.soulmates ?? 0}\n`;
		});

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar ranking.");
	}
}

/**
 * Exibe personagens mais populares e casados
 */
async function verTopCharacters(bot, message) {
	const chatId = message.group ?? message.author;

	try {
		const { data } = await api.get("/leaderboard/characters", { params: { limit: 5 } });
		const topClaimed = data.data?.topClaimed || [];
		const topLiked = data.data?.topLiked || [];

		let text = `🌟 *Personagens Mais Populares:*\n\n`;
		text += `💍 *Mais Casados:*\n`;
		topClaimed.forEach((c, i) => {
			text += `${i + 1}. *${c.name}* (${c.series}) — 💍 ${c.claimCount} casamentos\n`;
		});

		text += `\n❤️ *Mais Curtidos:*\n`;
		topLiked.forEach((c, i) => {
			text += `${i + 1}. *${c.name}* (${c.series}) — ❤️ ${c.likeCount} likes\n`;
		});

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar personagens populares.");
	}
}

/**
 * Busca personagens no catálogo por nome ou série
 */
async function buscarPersonagens(bot, message, args) {
	const chatId = message.group ?? message.author;

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "🔍 Informe o nome ou série para pesquisar.\nExemplo: `!mu-personagens Frieren`"
		});
	}

	const search = args.join(" ");

	try {
		const { data } = await api.get("/characters", {
			params: { search, limit: 10 }
		});

		const resultData = data.data;
		const chars = resultData.data || [];
		const total = resultData.total || 0;

		if (chars.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `🔍 Nenhum personagem encontrado para "${search}".`
			});
		}

		let text = `🔍 *Resultados para "${search}"* (Total: ${total}):\n\n`;
		chars.forEach((c, idx) => {
			const emojiRarity = RARITY_EMOJI[c.baseRarity || c.rarity] || "⚪";
			text += `${idx + 1}. ${emojiRarity} *${c.name}* — _${c.series}_\n`;
			text += `   ↳ ID: \`${c.id}\` | 💍 ${c.claimCount} | ❤️ ${c.likeCount}\n`;
		});

		text += `\n_Use \`!mu-char <id>\` para ver imagem e detalhes completos._`;
		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao buscar personagens.");
	}
}

/**
 * Exibe detalhes e imagem de um personagem específico
 */
async function detalhesPersonagem(bot, message, args) {
	const chatId = message.group ?? message.author;

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content: "❌ Informe o ID do personagem.\nExemplo: `!mu-char rem-re-zero`"
		});
	}

	const characterId = args[0].trim();

	try {
		const { data } = await api.get(`/characters/${characterId}`);
		const char = data.data;

		const rarity = char.baseRarity || char.rarity || "COMMON";
		const emojiRarity = RARITY_EMOJI[rarity] || "⚪";
		const labelRarity = RARITY_LABEL[rarity] || rarity;

		let text = `👤 *${char.name}* (${char.series})\n`;
		text += `⭐ Raridade: ${emojiRarity} *${labelRarity}*\n`;
		text += `⚧ Gênero: *${char.gender === "FEMALE" ? "Feminino" : char.gender === "MALE" ? "Masculino" : "Outro"}*\n`;
		text += `💍 Total de casamentos: *${char.claimCount}*\n`;
		text += `❤️ Curtidas: *${char.likeCount}*\n`;

		if (char.description) {
			text += `\n📝 _${char.description}_\n`;
		}

		if (char.tags && char.tags.length > 0) {
			text += `🏷️ Tags: _${char.tags.join(", ")}_\n`;
		}

		text += `\n🆔 ID: \`${char.id}\``;

		const imageBase64 = await downloadImageAsBase64(char.imageUrl);
		if (imageBase64) {
			return new ReturnMessage({
				chatId,
				content: {
					mimetype: "image/jpeg",
					data: imageBase64,
					filename: `${char.id}.jpg`,
					isMessageMedia: true
				},
				options: {
					caption: text
				}
			});
		}

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar personagem.");
	}
}

/**
 * Consulta cooldowns ativos do usuário
 */
async function verCooldowns(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/user/${userId}/cooldowns`);
		const { roll, claim, daily } = data.data;

		let text = `⏳ *Seus Cooldowns Atuais:*\n\n`;

		text += roll.active
			? `🎲 Sorteio (Roll): ❌ Aguarde *${formatRemainingSeconds(roll.remainingSeconds)}*\n`
			: `🎲 Sorteio (Roll): ✅ *Disponível agora!*\n`;

		text += claim.active
			? `💍 Casamento (Claim): ❌ Aguarde *${formatRemainingSeconds(claim.remainingSeconds)}*\n`
			: `💍 Casamento (Claim): ✅ *Disponível agora!*\n`;

		text += daily.active
			? `💜 Recompensa Diária (Zinthos): ❌ Aguarde *${formatRemainingSeconds(daily.remainingSeconds)}*\n`
			: `💜 Recompensa Diária (Zinthos): ✅ *Disponível agora!*\n`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar cooldowns.");
	}
}

/**
 * Explica o jogo (clone não-oficial de Mudae), suas mecânicas e lista todos os comandos
 */
async function ajudaWaifus(bot, message) {
	const chatId = message.group ?? message.author;

	let text = `🎲 *WAIFULETES (MUDAE)* — _Clone Não-Oficial do Mudae no WhatsApp_\n\n`;
	text += `O *Waifuletes* é um jogo de roleta de personagens de animes, mangás e games inspirado no clássico bot Mudae do Discord, totalmente adaptado para o WhatsApp através da API REST do Waifuletes.\n\n`;

	text += `━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `📖 *MECÂNICAS DO JOGO*\n`;
	text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

	text += `🎲 *1. Sorteio (Roll)*\n`;
	text += `• Ao rolar com \`!mu-roll\`, você sorteia um personagem aleatório dentre mais de 43.000 cadastrados.\n`;
	text += `• A chance de drop é ponderada pela raridade (⚪ Comum, 🟢 Incomum, 🔵 Raro, 🟣 Épico, ⭐ Lendário) e pela popularidade de casamentos/curtidas.\n`;
	text += `• Você pode filtrar apenas homens com \`!mu-rollm\` ou apenas mulheres com \`!mu-rollf\`.\n`;
	text += `• *Cooldown:* 10 minutos.\n\n`;

	text += `💍 *2. Casamento (Claim)*\n`;
	text += `• Quando um personagem *livre* é rolado no grupo, abre-se uma janela de *120 segundos (2 minutos)*.\n`;
	text += `• O primeiro jogador a enviar \`!mu-casar\` (ou \`!mu-c\`) se casa com a waifu/husbando!\n`;
	text += `• O personagem passa a pertencer ao seu Harém global (em todos os grupos do bot).\n`;
	text += `• *Cooldown de casamento:* 3 horas.\n\n`;

	text += `🔑 *3. Chaves (Keys) & Soulmates*\n`;
	text += `• Se você rolar um personagem que *já pertence a você*, você ganha *+1 Chave (Key)*!\n`;
	text += `• Ao acumular *10 Chaves*, esse personagem é promovido a *💖 Soulmate definitivo*!\n`;
	text += `• Soulmates são seus parceiros eternos e podem receber apelidos e notas.\n\n`;

	text += `💜 *4. Economia Zinthos*\n`;
	text += `• *Zinthos (💜)* é a moeda oficial do jogo.\n`;
	text += `• Resgate sua recompensa diária a cada 20 horas usando \`!mu-diario\`.\n`;
	text += `• Quando alguém rola um personagem que já é seu, um cristal de Zinthos é gerado com base no valor da sua waifu.\n`;
	text += `• Você também pode divorciar personagens com \`!mu-divorciar <id>\` para resgatar Zinthos proporcional à raridade e chaves.\n\n`;

	text += `🌟 *5. Lista de Desejos (Wishlist)*\n`;
	text += `• Adicione até 30 personagens à sua wishlist com \`!mu-desejar <id>\`.\n`;
	text += `• Personagens na sua lista têm probabilidade de drop significativamente aumentada nos seus rolls!\n\n`;

	text += `❤️ *6. Curtidas (Likes)*\n`;
	text += `• Dê like nos seus personagens favoritos com \`!mu-like <id>\` para aumentar a popularidade global deles.\n\n`;

	text += `━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `📋 *LISTA COMPLETA DE COMANDOS*\n`;
	text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

	text += `🎲 *Sorteio (Rolls):*\n`;
	text += `• \`!mu-roll\` (aliases: \`!mu-r\`, \`!mu-w\`, \`!mu-waifu\`) — Sorteia waifus e husbandos misturados.\n`;
	text += `• \`!mu-rollm\` (aliases: \`!mu-rm\`, \`!mu-husbando\`) — Sorteia apenas personagens masculinos.\n`;
	text += `• \`!mu-rollf\` (aliases: \`!mu-rf\`) — Sorteia apenas personagens femininos.\n\n`;

	text += `💍 *Casamento e Harém:*\n`;
	text += `• \`!mu-casar\` (aliases: \`!mu-c\`, \`!mu-claim\`, \`!mu-marry\`) — Casa com o personagem rolado nos últimos 120s.\n`;
	text += `• \`!mu-divorciar <id>\` (aliases: \`!mu-div\`, \`!mu-d\`) — Divorcia um personagem e resgata Zinthos.\n`;
	text += `• \`!mu-harem [página]\` (aliases: \`!mu-h\`, \`!mu-colecao\`) — Lista todas as waifus/husbandos que você possui.\n`;
	text += `• \`!mu-favorito <id>\` (aliases: \`!mu-fav\`) — Define seu personagem favorito em destaque.\n`;
	text += `• \`!mu-soulmates\` (aliases: \`!mu-sm\`, \`!mu-almas\`) — Lista seus parceiros com 10+ chaves.\n\n`;

	text += `💰 *Economia & Perfil:*\n`;
	text += `• \`!mu-diario\` (aliases: \`!mu-daily\`, \`!mu-dz\`, \`!mu-dk\`) — Coleta sua recompensa diária de Zinthos.\n`;
	text += `• \`!mu-saldo\` (aliases: \`!mu-zinthos\`, \`!mu-z\`, \`!mu-k\`) — Consulta seu saldo atual de Zinthos.\n`;
	text += `• \`!mu-perfil\` (aliases: \`!mu-p\`, \`!mu-eu\`) — Exibe seu perfil de jogador, estatísticas e favorita.\n`;
	text += `• \`!mu-ranking [top]\` (aliases: \`!mu-top\`, \`!mu-rank\`) — Ranking dos jogadores mais ricos em Zinthos.\n`;
	text += `• \`!mu-cooldowns\` (aliases: \`!mu-cd\`, \`!mu-tempo\`) — Consulta o tempo restante dos seus cooldowns.\n\n`;

	text += `🌟 *Wishlist e Catálogo:*\n`;
	text += `• \`!mu-wishlist\` (aliases: \`!mu-wl\`, \`!mu-desejos\`) — Lista seus personagens desejados.\n`;
	text += `• \`!mu-desejar <id>\` (aliases: \`!mu-wish\`, \`!mu-add\`) — Adiciona um personagem à sua wishlist.\n`;
	text += `• \`!mu-removerdesejo <id>\` (aliases: \`!mu-rmwish\`) — Remove um personagem da wishlist.\n`;
	text += `• \`!mu-like <id>\` (aliases: \`!mu-l\`, \`!mu-coracao\`) — Dá like em um personagem.\n`;
	text += `• \`!mu-personagens <busca>\` (aliases: \`!mu-chars\`, \`!mu-buscar\`) — Pesquisa personagens no catálogo por nome/série.\n`;
	text += `• \`!mu-char <id>\` (aliases: \`!mu-info\`, \`!mu-winfo\`) — Exibe foto e ficha técnica completa de um personagem.\n`;
	text += `• \`!mu-topchars\` (aliases: \`!mu-topwaifus\`, \`!mu-populares\`) — Mostra os personagens mais casados e curtidos no jogo.\n\n`;

	text += `ℹ️ *Ajuda do Jogo:*\n`;
	text += `• \`!waifus\` ou \`!mudae\` — Abre este menu explicativo com regras e comandos.`;

	return new ReturnMessage({
		chatId,
		content: text,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

// ─── Registro dos Comandos e Aliases (Padrão Stickers.js) ───────────────────

const commands = [
	// ── ROLL (Geral) ────────────────────────────────────────────────────────
	new Command({
		name: "mu-roll",
		description: "Sorteia um personagem aleatório (waifus e husbandos)",
		category: "jogos",
		group: "muwaifu-roll",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollAny
	}),
	new Command({
		name: "mu-r",
		description: "Alias curto para !mu-roll",
		category: "jogos",
		group: "muwaifu-roll",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollAny
	}),
	new Command({
		name: "mu-waifu",
		description: "Alias para !mu-roll",
		category: "jogos",
		group: "muwaifu-roll",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollAny
	}),
	new Command({
		name: "mu-w",
		description: "Alias curto para !mu-roll",
		category: "jogos",
		group: "muwaifu-roll",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollAny
	}),

	// ── ROLL MALE ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-rollm",
		description: "Sorteia apenas personagens masculinos (husbandos)",
		category: "jogos",
		group: "muwaifu-rollm",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollMale
	}),
	new Command({
		name: "mu-rm",
		description: "Alias de !mu-rollm",
		category: "jogos",
		group: "muwaifu-rollm",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollMale
	}),
	new Command({
		name: "mu-husbando",
		description: "Alias de !mu-rollm",
		category: "jogos",
		group: "muwaifu-rollm",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollMale
	}),

	// ── ROLL FEMALE ─────────────────────────────────────────────────────────
	new Command({
		name: "mu-rollf",
		description: "Sorteia apenas personagens femininos (waifus)",
		category: "jogos",
		group: "muwaifu-rollf",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollFemale
	}),
	new Command({
		name: "mu-rf",
		description: "Alias de !mu-rollf",
		category: "jogos",
		group: "muwaifu-rollf",
		reactions: { before: "🎲", after: "✅", error: "❌" },
		method: rollFemale
	}),

	// ── CASAR ───────────────────────────────────────────────────────────────
	new Command({
		name: "mu-casar",
		description: "Casa com o personagem sorteado recentemente (janela 120s)",
		category: "jogos",
		group: "muwaifu-casar",
		reactions: { before: "💍", after: "💍", error: "❌" },
		method: casarWaifu
	}),
	new Command({
		name: "mu-claim",
		description: "Alias de !mu-casar",
		category: "jogos",
		group: "muwaifu-casar",
		reactions: { before: "💍", after: "💍", error: "❌" },
		method: casarWaifu
	}),
	new Command({
		name: "mu-c",
		description: "Alias curto de !mu-casar",
		category: "jogos",
		group: "muwaifu-casar",
		reactions: { before: "💍", after: "💍", error: "❌" },
		method: casarWaifu
	}),
	new Command({
		name: "mu-marry",
		description: "Alias em inglês de !mu-casar",
		category: "jogos",
		group: "muwaifu-casar",
		reactions: { before: "💍", after: "💍", error: "❌" },
		method: casarWaifu
	}),

	// ── DIVORCIAR ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-divorciar",
		description: "Divorcia um personagem do harém e resgata Zinthos (💜)",
		category: "jogos",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		method: divorciarWaifu
	}),
	new Command({
		name: "mu-divorce",
		description: "Alias de !mu-divorciar",
		category: "jogos",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		method: divorciarWaifu
	}),
	new Command({
		name: "mu-div",
		description: "Alias curto de !mu-divorciar",
		category: "jogos",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		method: divorciarWaifu
	}),
	new Command({
		name: "mu-d",
		description: "Alias ultra-curto de !mu-divorciar",
		category: "jogos",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		method: divorciarWaifu
	}),

	// ── LIKE ────────────────────────────────────────────────────────────────
	new Command({
		name: "mu-like",
		description: "Dá like/coração em um personagem para aumentar sua popularidade",
		category: "jogos",
		group: "muwaifu-like",
		needsArgs: true,
		reactions: { before: "❤️", after: "❤️", error: "❌" },
		method: likeWaifu
	}),
	new Command({
		name: "mu-l",
		description: "Alias curto de !mu-like",
		category: "jogos",
		group: "muwaifu-like",
		needsArgs: true,
		reactions: { before: "❤️", after: "❤️", error: "❌" },
		method: likeWaifu
	}),
	new Command({
		name: "mu-coracao",
		description: "Alias de !mu-like",
		category: "jogos",
		group: "muwaifu-like",
		needsArgs: true,
		reactions: { before: "❤️", after: "❤️", error: "❌" },
		method: likeWaifu
	}),

	// ── DIÁRIO ──────────────────────────────────────────────────────────────
	new Command({
		name: "mu-diario",
		description: "Coleta sua recompensa diária de Zinthos (💜)",
		category: "jogos",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		method: diariosKakera
	}),
	new Command({
		name: "mu-daily",
		description: "Alias em inglês de !mu-diario",
		category: "jogos",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		method: diariosKakera
	}),
	new Command({
		name: "mu-dz",
		description: "Alias curto de !mu-diario (Daily Zinthos)",
		category: "jogos",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		method: diariosKakera
	}),
	new Command({
		name: "mu-dk",
		description: "Alias de compatibilidade de !mu-diario (Daily Kakera)",
		category: "jogos",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		method: diariosKakera
	}),
	new Command({
		name: "mu-zinthos-diario",
		description: "Alias descritivo de !mu-diario",
		category: "jogos",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		method: diariosKakera
	}),
	new Command({
		name: "mu-kakera-diario",
		description: "Alias de compatibilidade de !mu-diario",
		category: "jogos",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		method: diariosKakera
	}),

	// ── SALDO ───────────────────────────────────────────────────────────────
	new Command({
		name: "mu-saldo",
		description: "Consulta seu saldo atual de Zinthos (💜)",
		category: "jogos",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		method: saldoKakera
	}),
	new Command({
		name: "mu-zinthos",
		description: "Alias de !mu-saldo",
		category: "jogos",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		method: saldoKakera
	}),
	new Command({
		name: "mu-z",
		description: "Alias curto de !mu-saldo",
		category: "jogos",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		method: saldoKakera
	}),
	new Command({
		name: "mu-kakera",
		description: "Alias de compatibilidade de !mu-saldo",
		category: "jogos",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		method: saldoKakera
	}),
	new Command({
		name: "mu-k",
		description: "Alias curto de compatibilidade de !mu-saldo",
		category: "jogos",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		method: saldoKakera
	}),
	new Command({
		name: "mu-bal",
		description: "Alias em inglês de !mu-saldo",
		category: "jogos",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		method: saldoKakera
	}),

	// ── HARÉM ───────────────────────────────────────────────────────────────
	new Command({
		name: "mu-harem",
		description: "Lista todos os personagens pertencentes ao seu harém",
		category: "jogos",
		group: "muwaifu-harem",
		reactions: { before: "👰", after: "✅", error: "❌" },
		method: verHarem
	}),
	new Command({
		name: "mu-h",
		description: "Alias curto de !mu-harem",
		category: "jogos",
		group: "muwaifu-harem",
		reactions: { before: "👰", after: "✅", error: "❌" },
		method: verHarem
	}),
	new Command({
		name: "mu-colecao",
		description: "Alias de !mu-harem",
		category: "jogos",
		group: "muwaifu-harem",
		reactions: { before: "👰", after: "✅", error: "❌" },
		method: verHarem
	}),

	// ── PERFIL ──────────────────────────────────────────────────────────────
	new Command({
		name: "mu-perfil",
		description: "Exibe seu perfil completo no jogo, harém e waifu favorita",
		category: "jogos",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		method: verPerfil
	}),
	new Command({
		name: "mu-p",
		description: "Alias curto de !mu-perfil",
		category: "jogos",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		method: verPerfil
	}),
	new Command({
		name: "mu-profile",
		description: "Alias em inglês de !mu-perfil",
		category: "jogos",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		method: verPerfil
	}),
	new Command({
		name: "mu-eu",
		description: "Alias rápido de !mu-perfil",
		category: "jogos",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		method: verPerfil
	}),

	// ── WISHLIST ────────────────────────────────────────────────────────────
	new Command({
		name: "mu-wishlist",
		description: "Lista seus personagens desejados cadastrados",
		category: "jogos",
		group: "muwaifu-wl",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		method: verWishlist
	}),
	new Command({
		name: "mu-wl",
		description: "Alias curto de !mu-wishlist",
		category: "jogos",
		group: "muwaifu-wl",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		method: verWishlist
	}),
	new Command({
		name: "mu-desejos",
		description: "Alias em português de !mu-wishlist",
		category: "jogos",
		group: "muwaifu-wl",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		method: verWishlist
	}),

	// ── DESEJAR ─────────────────────────────────────────────────────────────
	new Command({
		name: "mu-desejar",
		description: "Adiciona um personagem à sua Wishlist (aumenta chance no roll)",
		category: "jogos",
		group: "muwaifu-wish",
		needsArgs: true,
		reactions: { before: "🌟", after: "⭐", error: "❌" },
		method: adicionarDesejo
	}),
	new Command({
		name: "mu-wish",
		description: "Alias em inglês de !mu-desejar",
		category: "jogos",
		group: "muwaifu-wish",
		needsArgs: true,
		reactions: { before: "🌟", after: "⭐", error: "❌" },
		method: adicionarDesejo
	}),
	new Command({
		name: "mu-add",
		description: "Alias de !mu-desejar",
		category: "jogos",
		group: "muwaifu-wish",
		needsArgs: true,
		reactions: { before: "🌟", after: "⭐", error: "❌" },
		method: adicionarDesejo
	}),

	// ── REMOVER DESEJO ──────────────────────────────────────────────────────
	new Command({
		name: "mu-removerdesejo",
		description: "Remove um personagem da sua Wishlist",
		category: "jogos",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		method: removerDesejo
	}),
	new Command({
		name: "mu-rmwish",
		description: "Alias curto de !mu-removerdesejo",
		category: "jogos",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		method: removerDesejo
	}),
	new Command({
		name: "mu-rmdesejo",
		description: "Alias de !mu-removerdesejo",
		category: "jogos",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		method: removerDesejo
	}),
	new Command({
		name: "mu-unwish",
		description: "Alias em inglês de !mu-removerdesejo",
		category: "jogos",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		method: removerDesejo
	}),

	// ── FAVORITO ────────────────────────────────────────────────────────────
	new Command({
		name: "mu-favorito",
		description: "Define um personagem do harém como o favorito principal em destaque",
		category: "jogos",
		group: "muwaifu-fav",
		needsArgs: true,
		reactions: { before: "⭐", after: "⭐", error: "❌" },
		method: definirFavorita
	}),
	new Command({
		name: "mu-fav",
		description: "Alias curto de !mu-favorito",
		category: "jogos",
		group: "muwaifu-fav",
		needsArgs: true,
		reactions: { before: "⭐", after: "⭐", error: "❌" },
		method: definirFavorita
	}),
	new Command({
		name: "mu-fave",
		description: "Alias de !mu-favorito",
		category: "jogos",
		group: "muwaifu-fav",
		needsArgs: true,
		reactions: { before: "⭐", after: "⭐", error: "❌" },
		method: definirFavorita
	}),

	// ── SOULMATES ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-soulmates",
		description: "Lista seus personagens que atingiram status de Soulmate (10+ chaves)",
		category: "jogos",
		group: "muwaifu-sm",
		reactions: { before: "💖", after: "✅", error: "❌" },
		method: verSoulmates
	}),
	new Command({
		name: "mu-sm",
		description: "Alias curto de !mu-soulmates",
		category: "jogos",
		group: "muwaifu-sm",
		reactions: { before: "💖", after: "✅", error: "❌" },
		method: verSoulmates
	}),
	new Command({
		name: "mu-almas",
		description: "Alias em português de !mu-soulmates",
		category: "jogos",
		group: "muwaifu-sm",
		reactions: { before: "💖", after: "✅", error: "❌" },
		method: verSoulmates
	}),

	// ── RANKING ─────────────────────────────────────────────────────────────
	new Command({
		name: "mu-ranking",
		description: "Ranking global de jogadores mais ricos em Zinthos (💜)",
		category: "jogos",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		method: verRanking
	}),
	new Command({
		name: "mu-top",
		description: "Alias de !mu-ranking",
		category: "jogos",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		method: verRanking
	}),
	new Command({
		name: "mu-rank",
		description: "Alias curto de !mu-ranking",
		category: "jogos",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		method: verRanking
	}),
	new Command({
		name: "mu-lb",
		description: "Alias Leaderboard de !mu-ranking",
		category: "jogos",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		method: verRanking
	}),

	// ── TOP PERSONAGENS ─────────────────────────────────────────────────────
	new Command({
		name: "mu-topchars",
		description: "Ranking dos personagens mais casados e mais curtidos",
		category: "jogos",
		group: "muwaifu-topchars",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		method: verTopCharacters
	}),
	new Command({
		name: "mu-topwaifus",
		description: "Alias de !mu-topchars",
		category: "jogos",
		group: "muwaifu-topchars",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		method: verTopCharacters
	}),
	new Command({
		name: "mu-populares",
		description: "Alias de !mu-topchars",
		category: "jogos",
		group: "muwaifu-topchars",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		method: verTopCharacters
	}),

	// ── BUSCAR PERSONAGENS ──────────────────────────────────────────────────
	new Command({
		name: "mu-personagens",
		description: "Busca personagens no catálogo por nome ou série",
		category: "jogos",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		method: buscarPersonagens
	}),
	new Command({
		name: "mu-chars",
		description: "Alias curto de !mu-personagens",
		category: "jogos",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		method: buscarPersonagens
	}),
	new Command({
		name: "mu-buscar",
		description: "Alias de !mu-personagens",
		category: "jogos",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		method: buscarPersonagens
	}),
	new Command({
		name: "mu-find",
		description: "Alias em inglês de !mu-personagens",
		category: "jogos",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		method: buscarPersonagens
	}),

	// ── DETALHES PERSONAGEM ─────────────────────────────────────────────────
	new Command({
		name: "mu-char",
		description: "Consulta detalhes e foto de um personagem por ID",
		category: "jogos",
		group: "muwaifu-char",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		method: detalhesPersonagem
	}),
	new Command({
		name: "mu-info",
		description: "Alias de !mu-char",
		category: "jogos",
		group: "muwaifu-char",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		method: detalhesPersonagem
	}),
	new Command({
		name: "mu-winfo",
		description: "Alias Waifu-Info de !mu-char",
		category: "jogos",
		group: "muwaifu-char",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		method: detalhesPersonagem
	}),

	// ── COOLDOWNS ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-cooldowns",
		description: "Consulta todos os seus tempos de espera ativos (roll, claim, daily)",
		category: "jogos",
		group: "muwaifu-cd",
		reactions: { before: "⏳", after: "✅", error: "❌" },
		method: verCooldowns
	}),
	new Command({
		name: "mu-cd",
		description: "Alias curto de !mu-cooldowns",
		category: "jogos",
		group: "muwaifu-cd",
		reactions: { before: "⏳", after: "✅", error: "❌" },
		method: verCooldowns
	}),
	new Command({
		name: "mu-tempo",
		description: "Alias em português de !mu-cooldowns",
		category: "jogos",
		group: "muwaifu-cd",
		reactions: { before: "⏳", after: "✅", error: "❌" },
		method: verCooldowns
	}),

	// ── AJUDA / GUIA DO JOGO (WAIFUS / MUNAE) ───────────────────────────────
	new Command({
		name: "waifus",
		description: "Explica as mecânicas do jogo Waifuletes/Munae e lista todos os comandos",
		category: "jogos",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		method: ajudaWaifus
	}),
	new Command({
		name: "munae",
		description: "Alias para o guia completo do jogo Waifuletes/Mudae",
		category: "jogos",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		method: ajudaWaifus
	}),
	new Command({
		name: "mudae",
		description: "Alias para o guia completo do jogo Waifuletes",
		category: "jogos",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		method: ajudaWaifus
	}),
	new Command({
		name: "mu-ajuda",
		description: "Alias de ajuda do jogo Waifuletes",
		category: "jogos",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		method: ajudaWaifus
	}),
	new Command({
		name: "mu-help",
		description: "Alias em inglês de ajuda do jogo Waifuletes",
		category: "jogos",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		method: ajudaWaifus
	})
];

const helper = {
	about: "Jogo de sorteio de waifus/husbandos (estilo Mudae) integrado com a API Waifuletes",
	implementation:
		"Consome a API REST local do Waifuletes para sorteio ponderado, casamentos em janela de 120s, harém global, chaves, soulmates e economia de Zinthos (💜).",
	tags: "waifu,mudae,munae,jogo,anime,harem,zinthos,kakera,roleta,casamento",
	cmds: [
		{
			cmd: "!waifus / !munae",
			desc: "Explica as mecânicas do jogo e lista todos os comandos e filtros disponíveis",
			usage: ["!waifus", "!munae", "!mu-ajuda"],
			category: "jogos"
		},
		{
			cmd: "!mu-roll",
			desc: "Sorteia um personagem aleatório para o grupo (waifus e husbandos)",
			usage: ["!mu-roll", "!mu-r", "!mu-rollm (só homens)", "!mu-rollf (só mulheres)"],
			category: "jogos"
		},
		{
			cmd: "!mu-casar",
			desc: "Casa com o personagem recém-sorteado dentro da janela de 120 segundos",
			usage: ["!mu-casar", "!mu-c", "!mu-casar rem-re-zero"],
			category: "jogos"
		},
		{
			cmd: "!mu-diario",
			desc: "Resgata a recompensa diária de Zinthos (💜)",
			usage: ["!mu-diario", "!mu-dz", "!mu-dk"],
			category: "jogos"
		},
		{
			cmd: "!mu-harem",
			desc: "Lista os personagens que você possui em seu harém",
			usage: ["!mu-harem", "!mu-h 2"],
			category: "jogos"
		},
		{
			cmd: "!mu-saldo",
			desc: "Consulta seu saldo atual de Zinthos (💜)",
			usage: ["!mu-saldo", "!mu-zinthos", "!mu-z", "!mu-k"],
			category: "jogos"
		},
		{
			cmd: "!mu-wishlist",
			desc: "Lista seus personagens desejados (aumenta drop rate no roll)",
			usage: ["!mu-wishlist", "!mu-desejar <id>", "!mu-removerdesejo <id>"],
			category: "jogos"
		},
		{
			cmd: "!mu-personagens",
			desc: "Busca personagens cadastrados no catálogo por nome ou série",
			usage: ["!mu-personagens Frieren", "!mu-chars Naruto"],
			category: "jogos"
		},
		{
			cmd: "!mu-ranking",
			desc: "Ranking dos jogadores mais ricos em Zinthos (💜)",
			usage: ["!mu-ranking", "!mu-top 10"],
			category: "jogos"
		},
		{
			cmd: "!mu-cooldowns",
			desc: "Verifica os tempos restantes para poder rolar, casar ou resgatar o diário",
			usage: ["!mu-cooldowns", "!mu-cd"],
			category: "jogos"
		}
	]
};

module.exports = {
	helper,
	commands,
	ajudaWaifus,
	rollAny,
	rollMale,
	rollFemale,
	casarWaifu,
	divorciarWaifu,
	likeWaifu,
	diariosKakera,
	saldoKakera,
	verHarem,
	verPerfil,
	verWishlist,
	adicionarDesejo,
	removerDesejo,
	definirFavorita,
	verSoulmates,
	verRanking,
	verTopCharacters,
	buscarPersonagens,
	detalhesPersonagem,
	verCooldowns,
	pendingClaims
};
