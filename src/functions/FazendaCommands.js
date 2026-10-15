/**
 * FazendaCommands.js
 *
 * Módulo de comandos para o minigame "Jardim das Sombras" (Fazenda).
 * Todos os comandos pertencem à categoria 'jogos'.
 */

const sharp = require("sharp");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Logger = require("../utils/Logger");
const { resolveMentionName } = require("../utils/ProfilePictureHelper");
const ShadowGardenClient = require("../services/ShadowGardenClient");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");

const logger = new Logger("fazenda-commands");
const jardimClient = new ShadowGardenClient();

// Regex para detecção de emojis Unicode
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

/**
 * Normaliza o ID do usuário (apenas dígitos)
 * @param {Object} message
 * @returns {string}
 */
function getUserId(message) {
	const raw = message.author || message.from || "";
	return String(raw).replace(/\D/g, "");
}

/**
 * Normaliza o ID do chat/conversa
 * @param {Object} message
 * @returns {string}
 */
function getChatId(message) {
	return message.group || message.author || message.from;
}

/**
 * Verifica se a mensagem veio de um chat privado (PV)
 * @param {Object} message
 * @returns {boolean}
 */
function isPrivateChat(message) {
	return !message.group;
}

/**
 * Extrai texto dos argumentos da mensagem
 * @param {Object} message
 * @returns {string}
 */
function getArgsText(message) {
	const parts = (message.content || "").trim().split(/\s+/);
	parts.shift(); // Remove o comando
	return parts.join(" ").trim();
}

/**
 * Obtém o nome ou apelido de exibição do usuário (respeitando apelido no grupo se definido)
 * @param {Object} bot
 * @param {Object} message
 * @param {Object} [group]
 * @returns {Promise<string>}
 */
async function getUserDisplayName(bot, message, group) {
	const userJid = message.author || message.from || "";
	const numDigits = userJid.split("@")[0].replace(/\D/g, "");
	let targetGroup = group;
	if (!targetGroup && message.group && bot?.groups) {
		targetGroup = bot.groups[message.group];
	}

	// 1. Apelido configurado no grupo (group.nicks) - imediato em memória
	if (targetGroup?.nicks && Array.isArray(targetGroup.nicks)) {
		const nickData = targetGroup.nicks.find((n) => {
			if (!n?.numero) return false;
			const nStr = String(n.numero);
			const nDigits = nStr.split("@")[0].replace(/\D/g, "");
			return nStr === userJid || (numDigits && nDigits === numDigits);
		});
		if (nickData?.apelido && nickData.apelido.trim()) {
			return nickData.apelido.trim();
		}
	}

	// 2. Nome push que já veio na mensagem do WhatsApp - imediato em memória
	const fallback = message.authorName || message.pushName || message.name;
	if (fallback && typeof fallback === "string" && fallback.trim()) {
		return fallback.trim();
	}

	// 3. Fallback assíncrono caso nenhum dos anteriores exista
	try {
		const name = await resolveMentionName(bot, userJid, targetGroup);
		if (name && typeof name === "string" && name.trim()) {
			return name.trim();
		}
	} catch (err) {
		logger.debug(`[getUserDisplayName] Erro ao resolver nome: ${err.message}`);
	}

	return "Cultivador";
}

let cachedTexts = null;
let lastTextsFetchTime = 0;
const TEXTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Obtém os textos e emoji do jogo configurados, com cache em memória
 * @returns {Promise<{ name: string, emoji: string }>}
 */
async function getGameTexts() {
	const now = Date.now();
	if (cachedTexts && now - lastTextsFetchTime < TEXTS_CACHE_TTL) {
		return cachedTexts;
	}
	try {
		const texts = await jardimClient.getTexts();
		if (texts && texts.gameName) {
			cachedTexts = {
				name: texts.gameName,
				emoji: texts.gameEmoji || "🦇"
			};
			lastTextsFetchTime = now;
			return cachedTexts;
		}
	} catch (err) {
		logger.warn(`[getGameTexts] Falha ao obter textos da API: ${err.message}`);
	}
	return cachedTexts || { name: "Jardim Lutoso", emoji: "🦇" };
}

/**
 * Cria uma instância de ReturnMessage com citação (reply) à mensagem de origem
 * @param {string} chatId
 * @param {string|Object} content
 * @param {Object} message
 * @param {Object} [extraOptions={}]
 * @returns {ReturnMessage}
 */
function replyReturnMessage(chatId, content, message, extraOptions = {}) {
	const options = {
		...(message?.origin?.id?._serialized && { quotedMessageId: message.origin.id._serialized }),
		...(message?.origin && { goReply: message.origin }),
		...extraOptions
	};
	return new ReturnMessage({
		chatId,
		content,
		options
	});
}

/**
 * Formata os buffs ativos do jogador em texto legível e sem repetições
 * @param {Object|Array} buffsData
 * @returns {string|null}
 */
function formatActiveBuffs(buffsData) {
	if (!buffsData) return null;

	const parts = [];

	if (buffsData.effectiveCoinMultiplier && buffsData.effectiveCoinMultiplier > 1.0) {
		parts.push(`💰 Moedas ${buffsData.effectiveCoinMultiplier}x`);
	}
	if (buffsData.effectiveGrowthMultiplier && buffsData.effectiveGrowthMultiplier < 1.0) {
		const pct = Math.round((1.0 - buffsData.effectiveGrowthMultiplier) * 100);
		parts.push(`⚡ Crescimento +${pct}%`);
	}
	if (buffsData.witherFrozen) {
		parts.push(`❄️ Imunidade a Murcha`);
	}
	if (buffsData.dailyLuckMultiplier && buffsData.dailyLuckMultiplier > 1.0) {
		parts.push(`🍀 Sorte da Sacola ${buffsData.dailyLuckMultiplier}x`);
	} else if (buffsData.dailySpecialItemBonus && buffsData.dailySpecialItemBonus > 0) {
		parts.push(`🍀 Sorte da Sacola +${Math.round(buffsData.dailySpecialItemBonus * 100)}%`);
	}

	if (parts.length === 0) {
		const list = Array.isArray(buffsData) ? buffsData : buffsData.activeBuffs || [];

		if (!Array.isArray(list) || list.length === 0) return null;

		const typeLabels = {
			coin_multiplier: "💰 Bônus de Moedas",
			coin_factor: "💰 Multiplicador de Moedas",
			growth_speed: "⚡ Velocidade de Crescimento",
			growth_reduction: "⚡ Redução de Tempo",
			growth_factor: "⚡ Aceleração do Vazio",
			growth_halve: "⚡ Crescimento Acelerado (Metade do Tempo)",
			wither_freeze: "❄️ Imunidade a Murcha",
			daily_luck: "🍀 Sorte da Sacola Diária",
			daily_bag_bonus: "🍀 Chance de Itens Especiais",
			daily_bag_luck: "🍀 Sorte Dupla Diária"
		};

		const seen = new Set();
		list.forEach((b) => {
			const type = typeof b === "string" ? b : b.type;
			if (!type || seen.has(type)) return;
			seen.add(type);
			const label = typeLabels[type] || `✨ ${type.replace(/_/g, " ")}`;
			parts.push(label);
		});
	}

	return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Formata segundos restantes de forma amigável
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatRemainingTime(totalSeconds) {
	if (!totalSeconds || totalSeconds <= 0) return "pronto para colheita";
	const mins = Math.floor(totalSeconds / 60);
	const secs = totalSeconds % 60;
	if (mins >= 60) {
		const hours = Math.floor(mins / 60);
		const remMins = mins % 60;
		return `${hours}h ${remMins}m`;
	}
	return `${mins}m ${secs}s`;
}

const HQ_FLAGS = new Set(["hd", "hq", "alta", "web", "full", "1024"]);

/**
 * Extrai flags de alta qualidade de uma lista de argumentos
 * @param {string[]} argsArray
 * @returns {{ isHighQuality: boolean, remainingArgs: string[] }}
 */
function extractQualityFlag(argsArray) {
	let isHighQuality = false;
	const remainingArgs = [];
	for (const arg of argsArray) {
		const clean = arg.toLowerCase().trim();
		if (HQ_FLAGS.has(clean)) {
			isHighQuality = true;
		} else {
			remainingArgs.push(arg);
		}
	}
	return { isHighQuality, remainingArgs };
}

/**
 * Otimiza a imagem da fazenda para envio rápido no WhatsApp
 * Reduz de 1024x1024 (~335KB) para 800x800 (~130KB), a menos que solicitada em alta resolução
 * @param {Buffer} imageBuffer - Buffer original da imagem 1024x1024
 * @param {boolean} [isHighQuality=false] - Se true, preserva a resolução nativa 1024x1024
 * @returns {Promise<Buffer>}
 */
async function optimizeFarmImage(imageBuffer, isHighQuality = false) {
	if (!imageBuffer || isHighQuality) {
		return imageBuffer;
	}
	try {
		return await sharp(imageBuffer)
			.resize(800, 800, { fit: "contain" })
			.jpeg({ quality: 75, mozjpeg: true })
			.toBuffer();
	} catch (err) {
		logger.warn(`[optimizeFarmImage] Falha ao otimizar imagem: ${err.message}`);
		return imageBuffer;
	}
}

/**
 * Converte emoji para string única em maiúsculas (ex: "1f332")
 * @param {string} emojiStr
 * @returns {string}
 */
function emojiToCodePoints(emojiStr) {
	return Array.from(emojiStr)
		.map((char) => char.codePointAt(0).toString(16).toLowerCase())
		.join("-");
}

/**
 * Detecta o primeiro emoji em uma imagem via renderização e comparação de pixels com Sharp
 * @param {Buffer} userImageBuffer
 * @returns {Promise<{ x: number, y: number, percentX: number, percentY: number } | null>}
 */
async function detectMarkerCoords(userImageBuffer, baseImageBuffer) {
	try {
		const targetSize = 256;
		const [userRaw, baseRaw] = await Promise.all([
			sharp(userImageBuffer)
				.resize(targetSize, targetSize, { fit: "fill" })
				.removeAlpha()
				.raw()
				.toBuffer(),
			sharp(baseImageBuffer)
				.resize(targetSize, targetSize, { fit: "fill" })
				.removeAlpha()
				.raw()
				.toBuffer()
		]);

		let sumDiff = 0;
		let weightedX = 0;
		let weightedY = 0;
		const threshold = 40; // Sensibilidade de diferença por canal RGB

		for (let y = 0; y < targetSize; y++) {
			for (let x = 0; x < targetSize; x++) {
				const idx = (y * targetSize + x) * 3;
				const dr = Math.abs(userRaw[idx] - baseRaw[idx]);
				const dg = Math.abs(userRaw[idx + 1] - baseRaw[idx + 1]);
				const db = Math.abs(userRaw[idx + 2] - baseRaw[idx + 2]);
				const diff = (dr + dg + db) / 3;

				if (diff > threshold) {
					sumDiff += diff;
					weightedX += x * diff;
					weightedY += y * diff;
				}
			}
		}

		if (sumDiff > 100) {
			const centroidX = weightedX / sumDiff;
			const centroidY = weightedY / sumDiff;
			const finalX = Math.round((centroidX / targetSize) * 1024);
			const finalY = Math.round((centroidY / targetSize) * 1024);
			return {
				x: Math.min(1000, Math.max(24, finalX)),
				y: Math.min(1000, Math.max(24, finalY)),
				percentX: Number((centroidX / targetSize).toFixed(3)),
				percentY: Number((centroidY / targetSize).toFixed(3))
			};
		}
	} catch (err) {
		logger.warn(`[detectMarkerCoords] Falha ao comparar imagens com Sharp: ${err.message}`);
	}
	return null;
}

// ─── HELPERS EXPORTADOS PARA OUTROS MÓDULOS (WAIFUS) ─────────────────────────

/**
 * Retorna se o usuário possui roll ou ticket bônus da fazenda acumulado
 * @param {string} userId
 * @returns {Promise<{ hasBonus: boolean, rolls: number, tickets: number }>}
 */
async function getFarmWaifuRollBonus(userId) {
	const bonus = await ShadowGardenBonusService.getWaifuBonus(userId);
	return {
		hasBonus: (bonus.rolls || 0) > 0 || (bonus.tickets || 0) > 0,
		rolls: bonus.rolls || 0,
		tickets: bonus.tickets || 0
	};
}

/**
 * Consome 1 roll ou ticket bônus da fazenda do usuário
 * @param {string} userId
 * @returns {Promise<{ consumed: boolean, type?: 'ticket' | 'roll', remainingRolls: number, remainingTickets: number }>}
 */
async function consumeFarmWaifuRoll(userId) {
	return await ShadowGardenBonusService.consumeWaifuBonus(userId);
}

// ─── HANDLERS DE COMANDOS DA FAZENDA ─────────────────────────────────────────

/**
 * !fazenda: Visualiza a fazenda atual com imagem 1024x1024, resgata diário se disponível
 */
async function handleFazenda(bot, message, _args, group) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const inPrivate = isPrivateChat(message);

	const rawArgs = getArgsText(message).split(/\s+/).filter(Boolean);
	const { isHighQuality } = extractQualityFlag(rawArgs);
	const wantsHq = isHighQuality || rawArgs.some((a) => a.toLowerCase().trim() === "max");

	try {
		// 1. Tenta coletar o bônus diário automaticamente
		let dailyClaimResult = null;
		try {
			const claimRes = await jardimClient.claimDaily(userId);
			if (claimRes && claimRes.claimed) {
				dailyClaimResult = claimRes;
			}
		} catch (claimErr) {
			logger.debug(`[handleFazenda] Tentativa de claim daily: ${claimErr.message}`);
		}

		// 2. Busca status da fazenda, textos configurados e nome do usuário em paralelo
		const [status, { name: gameName, emoji: gameEmoji }, userName] = await Promise.all([
			jardimClient.getStatus(userId),
			getGameTexts(),
			getUserDisplayName(bot, message, group)
		]);

		// 3. Tenta renderizar imagem (se falhar, envia mensagem de texto sem derrubar o comando)
		let imageBuffer = null;
		try {
			imageBuffer = await jardimClient.getImageBuffer(userId, true, { userName });
		} catch (imgErr) {
			logger.warn(
				`[handleFazenda] Não foi possível renderizar imagem da fazenda: ${imgErr.message}`
			);
		}

		// 4. Monta o texto de status
		const plots = status.slots || [];
		let readyCount = 0;
		let growingCount = 0;
		let dryCount = 0;
		let emptyCount = 0;

		plots.forEach((p) => {
			if (p.stage === "harvestable" || p.stage === "ready") readyCount++;
			else if (p.stage === "growing") growingCount++;
			else if (p.stage === "withered") dryCount++;
			else emptyCount++;
		});

		let text = `${gameEmoji} *${gameName.toUpperCase()}* ${gameEmoji}\n\n`;
		text += `💰 *Moedas:* ${status.coins ?? 0}\n`;
		text += `🌾 *Canteiros (9):* ${readyCount} prontos | ${growingCount} crescendo | ${dryCount} secos | ${emptyCount} livres\n`;

		const buffsFormatted = formatActiveBuffs(status.buffs);
		if (buffsFormatted) {
			text += `✨ *Buffs Ativos:* ${buffsFormatted}\n`;
		}

		text += `\n📖 *Comandos Rápidos:* \`!faz-colheita\`, \`!faz-plantar\`, \`!faz-loja\`, \`!faz-inv\``;

		// Link público da fazenda
		const shareUrl =
			status.shareUrl || (status.uuid ? `https://jds.moothz.win/farm?id=${status.uuid}` : null);
		if (shareUrl) {
			text += `\n\n🌐 *Ver Fazenda Online:* ${shareUrl}`;
		}

		if (wantsHq) {
			text += `\n📸 *Qualidade:* Alta Resolução (1024x1024)`;
		}

		if (inPrivate) {
			try {
				const adminRes = await jardimClient.getAdminUrl(userId);
				const adminUrl = typeof adminRes === "object" ? adminRes.url || adminRes.link : adminRes;
				if (adminUrl) {
					text += `\n\n🔐 *Acesso ao Farm Admin:* ${adminUrl}`;
				}
			} catch (admErr) {
				logger.warn(`[handleFazenda] Falha ao obter admin-url no PV: ${admErr.message}`);
			}
		} else {
			text += `\n\n💡 _Dica: Digite \`!faz-adm\` para receber o link do Farm Admin no seu privado!_`;
		}

		const returns = [];

		// Envia a imagem com a legenda principal se tiver, ou apenas texto se falhou a imagem
		if (imageBuffer) {
			const finalBuffer = await optimizeFarmImage(imageBuffer, wantsHq);
			returns.push(
				replyReturnMessage(
					chatId,
					{
						mimetype: "image/jpeg",
						data: finalBuffer.toString("base64"),
						filename: `fazenda-${userId}.jpg`,
						isMessageMedia: true
					},
					message,
					{
						caption: text
					}
				)
			);
		} else {
			returns.push(replyReturnMessage(chatId, text, message));
		}

		// Se coletou diário nesta chamada, envia segunda mensagem com o prêmio
		if (dailyClaimResult) {
			let dailyText = `🎁 *SACOLA DO COVEIRO RESGATADA!* 🎁\n\n`;
			dailyText += `Você abriu sua sacola diária e encontrou:\n`;
			dailyText += `• *+${dailyClaimResult.coinsWon || 0} Moedas*\n`;
			if (dailyClaimResult.itemsWon?.length > 0) {
				dailyClaimResult.itemsWon.forEach((it) => {
					dailyText += `• *${it.name || it.itemId}* (x${it.count || 1})\n`;
				});
			}
			dailyText += `\nVolte amanhã para resgatar novamente!`;

			returns.push(replyReturnMessage(chatId, dailyText, message));
		}

		return returns;
	} catch (err) {
		logger.error(`[handleFazenda] Erro ao carregar fazenda: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao acessar o Jardim: ${err.message}`, message);
	}
}

/**
 * !faz-adm: Envia link de acesso ao painel Farm Admin
 */
async function handleFazAdm(bot, message) {
	const userId = getUserId(message);
	const inPrivate = isPrivateChat(message);

	try {
		const adminRes = await jardimClient.getAdminUrl(userId);
		const adminUrl = typeof adminRes === "object" ? adminRes.url || adminRes.link : adminRes;
		const content = `🔐 *PAINEL FARM ADMIN* 🔐\n\nAcesse sua fazenda interativa pelo navegador:\n${adminUrl}\n\n⚠️ _Este link é pessoal e temporário. Não compartilhe com terceiros!_`;

		if (inPrivate) {
			return replyReturnMessage(message.author, content, message);
		}

		// Se enviado em grupo, despacha o link no PV e apenas reage à mensagem no grupo
		await bot.sendReturnMessages([
			new ReturnMessage({
				chatId: message.author,
				content
			})
		]);

		try {
			if (message.origin && typeof message.origin.react === "function") {
				await message.origin.react("📨");
			}
		} catch (reactErr) {
			logger.debug(`[handleFazAdm] Não foi possível reagir à mensagem: ${reactErr.message}`);
		}

		return null;
	} catch (err) {
		logger.error(`[handleFazAdm] Erro ao gerar admin url: ${err.message}`);
		return replyReturnMessage(
			getChatId(message),
			`❌ Não foi possível gerar seu link de acesso: ${err.message}`,
			message
		);
	}
}

/**
 * !faz-colher: Colhe plantas prontas e limpa canteiros secos
 */
async function handleFazColher(bot, message, _args, group) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const rawArgs = getArgsText(message).split(/\s+/).filter(Boolean);
	const { isHighQuality, remainingArgs } = extractQualityFlag(rawArgs);

	const slotArg = remainingArgs[0];
	const slotNum = slotArg && /^\d+$/.test(slotArg) ? parseInt(slotArg, 10) : null;

	try {
		const [harvestRes, { name: gameName }, userName] = await Promise.all([
			jardimClient.harvest(userId, slotNum, !slotNum),
			getGameTexts(),
			getUserDisplayName(bot, message, group)
		]);

		let text = `🌾 *COLHEITA DO ${gameName.toUpperCase()}* 🌾\n\n`;

		const harvested = harvestRes.harvested || [];
		const withered = harvestRes.clearedWithered || harvestRes.withered || [];

		if (harvested.length === 0 && withered.length === 0) {
			return replyReturnMessage(
				chatId,
				`⏳ Não há plantas prontas para colheita nem canteiros secos no momento.`,
				message
			);
		}

		if (harvested.length > 0) {
			text += `✨ *Itens Colhidos:*\n`;
			harvested.forEach((h) => {
				const qty = h.count || h.quantity || (Array.isArray(h.slots) ? h.slots.length : 1);
				let slotInfo = "";
				if (Array.isArray(h.slots) && h.slots.length > 0) {
					slotInfo = ` (Canteiro${h.slots.length > 1 ? "s" : ""} ${h.slots.map((s) => `#${s}`).join(", ")})`;
				} else if (h.slotIndex || h.slot) {
					slotInfo = ` (Canteiro #${h.slotIndex || h.slot})`;
				} else if (slotNum) {
					slotInfo = ` (Canteiro #${slotNum})`;
				}
				text += `• *${h.name || h.plantName || h.plantId}*: *${qty}x*${slotInfo}\n`;
			});
			text += "\n";
		}

		if (withered.length > 0) {
			text += `🥀 *Canteiros Secos Limpos:* ${withered.length} canteiro(s) liberado(s).\n\n`;
		}

		// Despacha bônus externos para outros jogos se houver
		const drops = harvestRes.externalDrops || harvestRes.bonusDrops || [];
		if (drops.length > 0) {
			const bonusMsgs = await ShadowGardenBonusService.dispatchHarvestDrops(userId, drops);
			if (bonusMsgs.length > 0) {
				text += `🎁 *BÔNUS ESPECIAIS CONCEDIDOS:*\n${bonusMsgs.join("\n")}\n\n`;
			}
		}

		text += `💰 *Saldo Atual:* ${harvestRes.coins ?? harvestRes.currentCoins ?? 0} moedas`;

		// Tenta renderizar imagem atualizada pós-colheita com efeito de fantasma dourado
		let imageBuffer = null;
		try {
			const harvestedSlots =
				harvested.length > 0
					? harvested
							.flatMap((h) => {
								if (Array.isArray(h.slots) && h.slots.length > 0) {
									return h.slots.map((s) => `${s}:${h.plantId}`);
								}
								if (h.slotIndex || h.slot) {
									return [`${h.slotIndex || h.slot}:${h.plantId}`];
								}
								if (slotNum && h.plantId) {
									return [`${slotNum}:${h.plantId}`];
								}
								return [];
							})
							.filter(Boolean)
							.join(",") || undefined
					: undefined;
			imageBuffer = await jardimClient.getImageBuffer(userId, true, {
				userName,
				harvestedSlots
			});
		} catch (imgErr) {
			logger.warn(
				`[handleFazColher] Não foi possível renderizar imagem da fazenda pós-colheita: ${imgErr.message}`
			);
		}

		if (imageBuffer) {
			const finalBuffer = await optimizeFarmImage(imageBuffer, isHighQuality);
			return replyReturnMessage(
				chatId,
				{
					mimetype: "image/jpeg",
					data: finalBuffer.toString("base64"),
					filename: `fazenda-colheita-${userId}.jpg`,
					isMessageMedia: true
				},
				message,
				{
					caption: text
				}
			);
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazColher] Erro na colheita: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha na colheita: ${err.message}`, message);
	}
}

/**
 * !faz-plantar: Planta sementes em canteiro específico ou em canteiros livres (padrão: 3)
 */
async function handleFazPlantar(bot, message, _args, group) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const rawArgs = getArgsText(message).split(/\s+/).filter(Boolean);
	const { isHighQuality, remainingArgs: args } = extractQualityFlag(rawArgs);

	if (args.length === 0) {
		return replyReturnMessage(
			chatId,
			`🌱 *Como plantar:*\n• \`!faz-plantar <semente>\` (planta até 3 nos canteiros livres)\n• \`!faz-plantar <semente> <qtd>\` (ex: \`!faz-plantar 3 5\` ou \`!faz-plantar 3 tudo\`)\n\nVeja suas sementes com \`!faz-inv\`.`,
			message
		);
	}

	const itemParam = args[0];
	let slotParam = null;
	let amountParam = 3; // Padrão: 3 sementes (se tiver)

	if (args[1]) {
		const secondArg = args[1].toLowerCase().trim();
		if (["tudo", "all", "max", "todas"].includes(secondArg)) {
			amountParam = 9;
		} else if (/^c\d+$/i.test(secondArg) || /^slot:\d+$/i.test(secondArg)) {
			slotParam = parseInt(secondArg.replace(/\D/g, ""), 10);
			amountParam = 1;
		} else if (/^\d+$/.test(secondArg)) {
			if (args[2] && /^\d+$/.test(args[2])) {
				amountParam = parseInt(secondArg, 10);
				slotParam = parseInt(args[2], 10);
			} else {
				amountParam = parseInt(secondArg, 10);
			}
		}
	}

	try {
		const [plantRes, userName] = await Promise.all([
			jardimClient.plant(userId, itemParam, slotParam, amountParam),
			getUserDisplayName(bot, message, group)
		]);

		const planted = plantRes.planted || (plantRes.slot ? [plantRes] : []);
		const plantedCount =
			plantRes.plantedCount || (plantRes.slots ? plantRes.slots.length : planted.length || 1);
		const plantName = plantRes.plantName || itemParam;
		const slotsList = (plantRes.slots || planted.map((p) => p.slotIndex || p.slot))
			.filter(Boolean)
			.map((s) => `#${s}`)
			.join(", ");

		const plural = plantedCount > 1 ? "sementes" : "semente";
		let text = `🌱 *Plantadas ${plantedCount} ${plural} de ${plantName}!* 🌱\n\n`;
		if (slotsList) {
			text += `🌾 *Canteiros ocupados:* ${slotsList}\n\n`;
		}
		text += `💡 _Você pode usar \`!faz-plantar ${itemParam} <qtd>\` para escolher quantas plantar (padrão: 3)._`;

		// Tenta renderizar imagem atualizada pós-plantio destacando os canteiros recém-plantados em verde
		let imageBuffer = null;
		try {
			const plantedSlots = (plantRes.slots || planted.map((p) => p.slotIndex || p.slot))
				.filter(Boolean)
				.join(",");
			imageBuffer = await jardimClient.getImageBuffer(userId, true, {
				userName,
				plantedSlots
			});
		} catch (imgErr) {
			logger.warn(
				`[handleFazPlantar] Não foi possível renderizar imagem da fazenda pós-plantio: ${imgErr.message}`
			);
		}

		if (imageBuffer) {
			const finalBuffer = await optimizeFarmImage(imageBuffer, isHighQuality);
			return replyReturnMessage(
				chatId,
				{
					mimetype: "image/jpeg",
					data: finalBuffer.toString("base64"),
					filename: `fazenda-plantio-${userId}.jpg`,
					isMessageMedia: true
				},
				message,
				{
					caption: text
				}
			);
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazPlantar] Erro ao plantar: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao plantar: ${err.message}`, message);
	}
}

/**
 * !faz-loja: Exibe sementes, elixires e decorações disponíveis para compra
 */
async function handleFazLoja(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const [{ name: gameName }, shop] = await Promise.all([
			getGameTexts(),
			jardimClient.getShop(userId)
		]);

		let text = `🛒 *MERCADO DO ${gameName.toUpperCase()}* 🛒\n\n`;

		if (shop.seeds?.length > 0) {
			text += `🌱 *SEMENTES:*\n`;
			shop.seeds.forEach((s) => {
				const rem =
					s.remainingToday !== undefined ? ` [${s.remainingToday}/${s.dailyLimit} hoje]` : "";
				text += `• *#${s.index} ${s.name}* — Compra: 💰 ${s.price} | Venda: 🪙 ${s.sellPrice || 0} (${s.growthMinutes}m)${rem}\n  _${s.description || ""}_\n`;
			});
			text += "\n";
		}

		if (shop.consumables?.length > 0) {
			text += `🧪 *ELIXIRES & CONSUMÍVEIS:*\n`;
			shop.consumables.forEach((c) => {
				const rem =
					c.remainingToday !== undefined ? ` [${c.remainingToday}/${c.dailyLimit} hoje]` : "";
				text += `• *#${c.index} ${c.name}* — 💰 ${c.price} moedas${rem}\n  _${c.description || ""}_\n`;
			});
			text += "\n";
		}

		if (shop.decorations?.length > 0) {
			text += `🏺 *DECORAÇÕES:*\n`;
			shop.decorations.forEach((d) => {
				text += `• *#${d.index} ${d.name}* — 💰 ${d.price} moedas [Tier: ${d.tier}]\n`;
			});
			text += "\n";
		}

		text += `🛍️ *Para comprar:* \`!faz-comprar <número ou nome> [quantidade]\``;

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazLoja] Erro ao carregar loja: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao carregar loja: ${err.message}`, message);
	}
}

/**
 * !faz-comprar: Compra sementes, elixires ou decorações da loja
 */
async function handleFazComprar(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	if (args.length === 0) {
		return replyReturnMessage(
			chatId,
			`🛒 *Como comprar:*\n• \`!faz-comprar <id ou número do item> [quantidade]\`\nExemplo: \`!faz-comprar 1 5\` (compra 5 sementes do item #1)`,
			message
		);
	}

	const itemParam = args[0];
	const quantity = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : 1;

	try {
		const buyRes = await jardimClient.buy(userId, itemParam, quantity);

		const returns = [];

		let text = `🛍️ *COMPRA REALIZADA COM SUCESSO!* 🛍️\n\n`;
		text += `• Item: *${buyRes.itemName || buyRes.item?.name || itemParam}*\n`;
		text += `• Quantidade: *${buyRes.quantityBought || quantity}x*\n`;
		text += `• Total Pago: *${buyRes.totalCost || buyRes.totalPrice || buyRes.cost || 0} moedas*\n`;
		text += `• Saldo Restante: *${buyRes.remainingCoins ?? buyRes.coins ?? 0} moedas*`;

		returns.push(replyReturnMessage(chatId, text, message));

		// Se a API retornou o sticker WebP/PNG em Base64, converte para WebP e envia como figurinha
		if (buyRes.stickerBase64) {
			try {
				const cleanBase64 = String(buyRes.stickerBase64).replace(/^data:image\/\w+;base64,/, "");
				const pngBuffer = Buffer.from(cleanBase64, "base64");
				// Converte para WebP 512x512 transparente para sticker do WhatsApp
				const webpBuffer = await sharp(pngBuffer)
					.resize(512, 512, {
						fit: "contain",
						background: { r: 0, g: 0, b: 0, alpha: 0 }
					})
					.webp({ quality: 90, effort: 4 })
					.toBuffer();

				const stickerMedia = {
					mimetype: "image/webp",
					data: webpBuffer.toString("base64"),
					filename: `sticker-${itemParam}.webp`,
					isMessageMedia: true
				};
				returns.push(
					replyReturnMessage(chatId, stickerMedia, message, {
						sendMediaAsSticker: true,
						stickerAuthor: bot?.nomeExibir || "ravena",
						stickerName: `Jardim: ${buyRes.itemName || itemParam}`
					})
				);
			} catch (stickerErr) {
				logger.error(
					`[handleFazComprar] Erro ao converter sticker da compra para WebP: ${stickerErr.message}`
				);
			}
		}

		return returns;
	} catch (err) {
		logger.error(`[handleFazComprar] Erro ao comprar: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha na compra: ${err.message}`, message);
	}
}

/**
 * !faz-inventario: Exibe o inventário do jogador (sementes, consumíveis, colheitas e decorações)
 */
async function handleFazInventario(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const [{ name: gameName }, inv] = await Promise.all([
			getGameTexts(),
			jardimClient.getInventory(userId)
		]);

		let text = `🎒 *MOCHILA DO ${gameName.toUpperCase()}* 🎒\n\n`;

		const items = inv.items || inv.inventory || [];
		if (items.length === 0) {
			text += `Sua mochila está completamente vazia no momento.\nVisite a loja com \`!faz-loja\` para adquirir sementes!`;
			return replyReturnMessage(chatId, text, message);
		}

		const seeds = items.filter((i) => i.type === "seed" || i.category === "seed");
		const crops = items.filter((i) => i.type === "crop" || i.category === "crop");
		const consumables = items.filter((i) => i.type === "consumable" || i.category === "consumable");
		const decors = items.filter((i) => i.type === "decoration" || i.category === "decoration");

		const getItemPrefix = (item) => {
			const id = item.catalogIndex ?? item.index ?? item.id ?? item.itemId;
			return id !== undefined && id !== null && id !== "" ? `[${id}] ` : "";
		};

		if (seeds.length > 0) {
			text += `🌱 *Sementes:*\n`;
			seeds.forEach((s) => {
				text += `• ${getItemPrefix(s)}${s.name}: *${s.quantity}x*\n`;
			});
			text += "\n";
		}

		if (crops.length > 0) {
			text += `🌾 *Colheitas Prontas (Venda com !faz-vender):*\n`;
			crops.forEach((c) => {
				text += `• ${getItemPrefix(c)}${c.name}: *${c.quantity}x* (💰 ${c.sellPrice || 0} cada)\n`;
			});
			text += "\n";
		}

		if (consumables.length > 0) {
			text += `🧪 *Elixires & Poções:*\n`;
			consumables.forEach((c) => {
				text += `• ${getItemPrefix(c)}${c.name}: *${c.quantity}x*\n`;
			});
			text += "\n";
		}

		if (decors.length > 0) {
			text += `🏺 *Decorações:*\n`;
			decors.forEach((d) => {
				text += `• ${getItemPrefix(d)}${d.name}: *${d.quantity}x*\n`;
			});
			text += "\n";
		}

		// Checa também se possui bônus acumulados de Waifus ganhos da fazenda
		const waifuBonus = await ShadowGardenBonusService.getWaifuBonus(userId);
		if (waifuBonus.rolls > 0 || waifuBonus.tickets > 0) {
			text += `💖 *Bônus Especiais para Waifus:*\n`;
			if (waifuBonus.rolls > 0) text += `• Rolls Gratuitos da Fazenda: *${waifuBonus.rolls}*\n`;
			if (waifuBonus.tickets > 0) text += `• Tickets Raros de Waifus: *${waifuBonus.tickets}*\n`;
			text += "\n";
		}

		text += `💡 *Ações:* \`!faz-plantar\`, \`!faz-usar\`, \`!faz-vender\`, \`!faz-decorar\``;

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazInventario] Erro ao carregar inventário: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao buscar inventário: ${err.message}`, message);
	}
}

/**
 * !faz-usar: Consome um elixir ou poção do inventário
 */
async function handleFazUsar(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	if (args.length === 0) {
		return replyReturnMessage(
			chatId,
			`🧪 *Como usar um elixir:*\n• \`!faz-usar <id ou nome do elixir> [canteiro]\`\nExemplo: \`!faz-usar blood_ruby 1\``,
			message
		);
	}

	const itemParam = args[0];
	const slotParam = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : null;

	try {
		const useRes = await jardimClient.useConsumable(userId, itemParam, slotParam);

		let text = `🧪 *ELIXIR UTILIZADO!* 🧪\n\n`;
		text += `• Efeito: *${useRes.message || useRes.effect || "Elixir ativado com sucesso!"}*\n`;
		if (useRes.remainingQuantity !== undefined) {
			text += `• Quantidade Restante: *${useRes.remainingQuantity}x*`;
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazUsar] Erro ao usar elixir: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao usar item: ${err.message}`, message);
	}
}

/**
 * !faz-vender: Vende colheitas do inventário por moedas
 */
async function handleFazVender(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	const sellAll = args.length === 0 || args[0].toLowerCase() === "tudo";
	const itemParam = !sellAll ? args[0] : null;
	const quantity = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : null;

	try {
		const sellRes = await jardimClient.sell(userId, {
			all: sellAll,
			...(itemParam && { itemId: itemParam }),
			...(quantity && { quantity })
		});

		const earned = sellRes.totalCoinsEarned ?? sellRes.earnedCoins ?? sellRes.totalGained ?? 0;
		const balance = sellRes.newCoinsBalance ?? sellRes.currentCoins ?? sellRes.coins ?? 0;

		let text = `💰 *VENDA REALIZADA COM SUCESSO!* 💰\n\n`;
		text += `• Moedas Ganhas: *+${earned} moedas*\n`;
		text += `• Saldo Atual: *${balance} moedas*\n`;

		if (sellRes.soldItems?.length > 0) {
			text += `\nItens vendidos:\n`;
			sellRes.soldItems.forEach((it) => {
				text += `• ${it.name || it.itemId}: ${it.quantity}x\n`;
			});
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazVender] Erro ao vender colheitas: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha na venda: ${err.message}`, message);
	}
}

/**
 * !faz-decorar: Posiciona enfeite via slot ou comparação de imagem citada com Sharp
 */
async function handleFazDecorar(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	// Checa se o usuário enviou uma imagem citada ou mídia
	const quoted = message.origin?.getQuotedMessage ? await message.origin.getQuotedMessage() : null;
	const userMedia = message.media || quoted?.media || null;

	if (args.length === 0) {
		return replyReturnMessage(
			chatId,
			`🏺 *Como posicionar enfeites:*\n• Por slot: \`!faz-decorar <enfeite> <slot de 1 a 4>\`\n• Por coordenadas: \`!faz-decorar <enfeite> <slot> <x> <y>\`\n• Por imagem: Marque um emoji sobre o terreno na foto da sua fazenda e envie respondendo: \`!faz-decorar <enfeite>\``,
			message
		);
	}

	const decorParam = args[0];
	const slotIndex = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : 1;
	let x = args[2] && /^\d+$/.test(args[2]) ? parseInt(args[2], 10) : undefined;
	let y = args[3] && /^\d+$/.test(args[3]) ? parseInt(args[3], 10) : undefined;

	// Se houver mídia (imagem modificada com emoji/marcação), processa centroid diff com Sharp
	if (userMedia && Buffer.isBuffer(userMedia)) {
		try {
			const baseImage = await jardimClient.getImageBuffer(userId, false);
			const detected = await detectMarkerCoords(userMedia, baseImage);
			if (detected) {
				x = detected.x;
				y = detected.y;
				logger.info(`[handleFazDecorar] Emoji/marcador detectado via Sharp em x=${x}, y=${y}`);
			}
		} catch (detectErr) {
			logger.warn(
				`[handleFazDecorar] Detecção de emoji falhou, usando slot padrão: ${detectErr.message}`
			);
		}
	}

	try {
		const payload = {
			decorId: decorParam,
			slotIndex,
			...(x !== undefined && { x }),
			...(y !== undefined && { y })
		};

		const decorRes = await jardimClient.decorate(userId, payload);

		let text = `🏺 *ENFEITE POSICIONADO COM SUCESSO!* 🏺\n\n`;
		text += `• Enfeite: *${decorRes.name || decorRes.decorId || decorParam}*\n`;
		text += `• Slot Decorativo: *#${decorRes.slotIndex || slotIndex}*\n`;
		if (decorRes.x !== undefined && decorRes.y !== undefined) {
			text += `• Posição: *(${decorRes.x}, ${decorRes.y})*\n`;
		}
		text += `\nVeja o novo visual com \`!fazenda\`!`;

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazDecorar] Erro ao posicionar enfeite: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao posicionar enfeite: ${err.message}`, message);
	}
}

/**
 * Verifica se um identificador de usuário pertence a testes ou simulações
 * @param {string} userId
 * @returns {boolean}
 */
function isTestUser(userId) {
	if (!userId) return true;
	const s = String(userId).trim().toLowerCase();
	return (
		s.startsWith("test") ||
		s.startsWith("sim") ||
		s.includes("test") ||
		s.includes("sim") ||
		s === "calibrate" ||
		s === "1"
	);
}

/**
 * Resolve o apelido ou nome amigável do usuário preservando a privacidade
 * @param {WhatsAppBot} bot
 * @param {string} userId
 * @param {Object} [message]
 * @param {Object} [group]
 * @returns {Promise<string>}
 */
async function resolvePlayerRankingName(bot, userId, message, group) {
	if (!userId) return "Cultivador";

	const strId = String(userId).trim();
	const numDigits = strId.split("@")[0].replace(/\D/g, "");

	// Se for o próprio autor da mensagem atual
	const authorJid = message?.author || message?.from || "";
	const authorDigits = authorJid.split("@")[0].replace(/\D/g, "");
	const isAuthor = strId === authorJid || (numDigits && authorDigits === numDigits);

	let targetGroup = group;
	if (!targetGroup && message?.group && bot?.groups) {
		targetGroup = bot.groups[message.group];
	}

	// 1. Apelido configurado no grupo atual (group.nicks)
	if (targetGroup?.nicks && Array.isArray(targetGroup.nicks)) {
		const nickData = targetGroup.nicks.find((n) => {
			if (!n?.numero) return false;
			const nStr = String(n.numero);
			const nDigits = nStr.split("@")[0].replace(/\D/g, "");
			return nStr === strId || (numDigits && nDigits === numDigits);
		});
		if (nickData?.apelido && nickData.apelido.trim()) {
			return nickData.apelido.trim();
		}
	}

	// 2. Se for o autor da mensagem, aproveitar pushName/authorName da mensagem
	if (isAuthor) {
		const fallback = message?.authorName || message?.pushName || message?.name;
		if (fallback && typeof fallback === "string" && fallback.trim()) {
			const clean = fallback.trim();
			if (
				clean !== strId &&
				clean.replace(/\D/g, "") !== numDigits &&
				clean !== "." &&
				clean !== "..."
			) {
				return clean;
			}
		}
	}

	// 3. Apelido em outros grupos onde o bot participa
	if (bot?.groups && typeof bot.groups === "object") {
		for (const gId of Object.keys(bot.groups)) {
			const otherGroup = bot.groups[gId];
			if (otherGroup?.nicks && Array.isArray(otherGroup.nicks)) {
				const nickData = otherGroup.nicks.find((n) => {
					if (!n?.numero) return false;
					const nStr = String(n.numero);
					const nDigits = nStr.split("@")[0].replace(/\D/g, "");
					return nStr === strId || (numDigits && nDigits === numDigits);
				});
				if (nickData?.apelido && nickData.apelido.trim()) {
					return nickData.apelido.trim();
				}
			}
		}
	}

	// 4. Fallback através do resolveMentionName
	const jid = strId.includes("@")
		? strId
		: numDigits.length >= 10
			? `${numDigits}@s.whatsapp.net`
			: strId;

	try {
		const name = await resolveMentionName(bot, jid, targetGroup);
		if (name && typeof name === "string" && name.trim()) {
			const clean = name.trim();
			const cleanDigits = clean.replace(/\D/g, "");
			if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
				return clean;
			}
		}
	} catch (err) {
		logger.debug(`[resolvePlayerRankingName] Erro em resolveMentionName: ${err.message}`);
	}

	// 5. Consulta cache pushname do bot
	try {
		if (typeof bot?.fetchPushNameFromCache === "function") {
			const cacheObj = await bot.fetchPushNameFromCache(jid);
			const pName = cacheObj?.pushName ?? cacheObj?.pushname ?? cacheObj;
			if (pName && typeof pName === "string" && pName.trim()) {
				const clean = pName.trim();
				const cleanDigits = clean.replace(/\D/g, "");
				if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
					return clean;
				}
			}
		}
	} catch (err) {
		logger.debug(`[resolvePlayerRankingName] Erro em fetchPushNameFromCache: ${err.message}`);
	}

	// 6. Consulta no SQLite (cache.db e msgranking.db)
	try {
		const Database = require("../utils/Database");
		const db = Database.getInstance();

		// msgranking.db tem o nome registrado em mensagens
		const msgRow = await db.dbGet(
			"msgranking",
			"SELECT user_name FROM ranking WHERE user_id LIKE ? AND user_name IS NOT NULL AND user_name != '' LIMIT 1;",
			[`%${numDigits || strId}%`]
		);
		if (msgRow?.user_name && typeof msgRow.user_name === "string" && msgRow.user_name.trim()) {
			const clean = msgRow.user_name.trim();
			const cleanDigits = clean.replace(/\D/g, "");
			if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
				return clean;
			}
		}

		// cache.db pushnames
		const pushRow = await db.dbGet(
			"cache",
			"SELECT pushname FROM pushnames WHERE id = ? OR id = ? OR id LIKE ? LIMIT 1;",
			[jid, strId, `%${numDigits || strId}%`]
		);
		if (pushRow?.pushname && typeof pushRow.pushname === "string" && pushRow.pushname.trim()) {
			const clean = pushRow.pushname.trim();
			const cleanDigits = clean.replace(/\D/g, "");
			if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
				return clean;
			}
		}

		// cache.db tg_names (Telegram)
		const tgRow = await db.dbGet("cache", "SELECT json_data FROM tg_names WHERE key = ? LIMIT 1;", [
			`tg_name:${strId}`
		]);
		if (tgRow?.json_data) {
			try {
				const parsed = JSON.parse(tgRow.json_data);
				if (parsed && typeof parsed === "string" && parsed.trim()) {
					return parsed.trim();
				}
			} catch (_) {}
		}
	} catch (err) {
		logger.debug(`[resolvePlayerRankingName] Erro na consulta SQLite: ${err.message}`);
	}

	// 7. Fallback seguro que NUNCA expõe o número completo
	if (numDigits.length >= 4) {
		return `Cultivador (...${numDigits.slice(-4)})`;
	}
	return "Cultivador";
}

/**
 * !faz-ranking: Exibe rankings de riqueza e de colheitas
 */
async function handleFazRanking(bot, message, args = [], group = null) {
	const chatId = getChatId(message);
	const argsText = getArgsText(message).toLowerCase();

	const isFarmers = argsText.includes("colheita") || argsText.includes("farmer");

	let targetGroup = group;
	if (!targetGroup && message?.group && bot?.groups) {
		targetGroup = bot.groups[message.group];
	}

	try {
		let text = "";
		if (isFarmers) {
			const farmers = await jardimClient.getFarmersRanking(25);
			text += `🏆 *TOP 10 MESTRES DA COLHEITA* 🏆\n\n`;
			const rawList = farmers.ranking || farmers || [];
			const list = rawList.filter((f) => !isTestUser(f.userId || f.playerId));
			const topList = list.slice(0, 10);
			const resolvedNames = await Promise.all(
				topList.map((f) =>
					resolvePlayerRankingName(bot, f.userId || f.playerId, message, targetGroup)
				)
			);
			topList.forEach((f, idx) => {
				const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}º.`;
				const name = resolvedNames[idx];
				text += `${medal} *${name}* — *${f.harvestCount || f.totalHarvested || 0} colheitas*\n`;
			});
			text += `\n_Para ver o ranking de moedas, digite \`!faz-ranking riqueza\`_`;
		} else {
			const wealth = await jardimClient.getWealthRanking(25);
			text += `🏆 *TOP 10 FAZENDEIROS MAIS RICOS* 🏆\n\n`;
			const rawList = wealth.ranking || wealth || [];
			const list = rawList.filter((w) => !isTestUser(w.userId || w.playerId));
			const topList = list.slice(0, 10);
			const resolvedNames = await Promise.all(
				topList.map((w) =>
					resolvePlayerRankingName(bot, w.userId || w.playerId, message, targetGroup)
				)
			);
			topList.forEach((w, idx) => {
				const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}º.`;
				const name = resolvedNames[idx];
				text += `${medal} *${name}* — 💰 *${w.coins || 0} moedas*\n`;
			});
			text += `\n_Para ver o ranking de colheitas, digite \`!faz-ranking colheitas\`_`;
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazRanking] Erro ao buscar rankings: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao carregar ranking: ${err.message}`, message);
	}
}

/**
 * !faz-ajuda: Guia geral dos comandos da Fazenda
 */
async function handleFazAjuda(bot, message) {
	const chatId = getChatId(message);
	const { name: gameName, emoji: gameEmoji } = await getGameTexts();

	const text =
		`${gameEmoji} *GUIA DO ${gameName.toUpperCase()}* ${gameEmoji}\n\n` +
		`• \`!fazenda [hd]\` — Ver a sua fazenda (adicione \`hd\` para resolução máxima) e resgatar diário\n` +
		`• \`!faz-adm\` — Obter link do painel web Farm Admin no privado\n` +
		`• \`!faz-colheita [canteiro] [hd]\` — Colher plantas maduras e limpar canteiros secos\n` +
		`• \`!faz-plantar <semente> [canteiro] [hd]\` — Semear nos canteiros livres ou específico\n` +
		`• \`!faz-loja\` — Ver catálogo de sementes, elixires e decorações\n` +
		`• \`!faz-comprar <item> [qtd]\` — Comprar itens na loja\n` +
		`• \`!faz-inventario\` — Ver seus itens, sementes e bônus acumulados\n` +
		`• \`!faz-usar <elixir> [canteiro]\` — Ativar poções mágicas\n` +
		`• \`!faz-vender [item ou tudo]\` — Vender suas colheitas por moedas\n` +
		`• \`!faz-decorar <enfeite> [slot]\` — Posicionar itens decorativos\n` +
		`• \`!faz-ranking\` — Ver o ranking dos melhores fazendeiros\n` +
		`• \`!faz-ajuda\` — Exibir este menu de ajuda`;

	return replyReturnMessage(chatId, text, message);
}

// ─── DEFINIÇÃO DOS COMANDOS EXPORTADOS ──────────────────────────────────────

const commands = [
	new Command({
		name: "fazenda",
		aliases: ["jardim"],
		description: "Visualiza a fazenda atual no Jardim das Sombras e coleta o diário",
		usage: "!fazenda [hd]",
		category: "jogos",
		reply: true,
		cooldown: 5,
		method: handleFazenda
	}),
	new Command({
		name: "faz-adm",
		aliases: ["faz-admin"],
		description: "Gera o link de autenticação seguro para o painel Farm Admin",
		usage: "!faz-adm",
		category: "jogos",
		reply: true,
		cooldown: 10,
		method: handleFazAdm
	}),
	new Command({
		name: "faz-colheita",
		aliases: ["faz-colheitatudo"],
		description: "Colhe plantas maduras e limpa canteiros secos",
		usage: "!faz-colheita [número do canteiro] [hd]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazColher
	}),
	new Command({
		name: "faz-colher",
		aliases: ["faz-colhertudo"],
		description: "Colhe plantas maduras e limpa canteiros secos",
		usage: "!faz-colher [número do canteiro] [hd]",
		category: "jogos",
		reply: true,
		hidden: true,
		cooldown: 3,
		method: handleFazColher
	}),
	new Command({
		name: "faz-plantar",
		aliases: ["faz-plantartudo"],
		description: "Planta sementes em canteiro específico ou em todos os canteiros livres",
		usage: "!faz-plantar <semente> [canteiro ou qtd] [hd]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazPlantar
	}),
	new Command({
		name: "faz-loja",
		aliases: ["faz-shop"],
		description: "Visualiza catálogo de sementes, elixires e decorações",
		usage: "!faz-loja",
		category: "jogos",
		reply: true,
		cooldown: 5,
		method: handleFazLoja
	}),
	new Command({
		name: "faz-comprar",
		aliases: ["faz-buy"],
		description: "Compra sementes, elixires ou decorações da loja",
		usage: "!faz-comprar <item> [quantidade]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazComprar
	}),
	new Command({
		name: "faz-inventario",
		aliases: ["faz-inv"],
		description: "Exibe a mochila de itens, sementes e bônus acumulados",
		usage: "!faz-inventario",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazInventario
	}),
	new Command({
		name: "faz-usar",
		aliases: ["faz-use"],
		description: "Utiliza um elixir ou consumível do inventário",
		usage: "!faz-usar <elixir> [canteiro]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazUsar
	}),
	new Command({
		name: "faz-vender",
		aliases: ["faz-vendertudo"],
		description: "Vende colheitas do inventário por moedas",
		usage: "!faz-vender [item ou tudo]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazVender
	}),
	new Command({
		name: "faz-decorar",
		aliases: ["faz-enfeitar"],
		description: "Posiciona ou reposiciona itens decorativos no terreno da fazenda",
		usage: "!faz-decorar <enfeite> [slot ou com imagem marcada]",
		category: "jogos",
		reply: true,
		cooldown: 5,
		method: handleFazDecorar
	}),
	new Command({
		name: "faz-ranking",
		aliases: ["faz-rank"],
		description: "Exibe os rankings de riqueza ou mestres da colheita",
		usage: "!faz-ranking [riqueza|colheitas]",
		category: "jogos",
		reply: true,
		cooldown: 5,
		method: handleFazRanking
	}),
	new Command({
		name: "faz-ajuda",
		aliases: ["faz-help"],
		description: "Exibe guia de comandos e mecânicas do Jardim das Sombras",
		usage: "!faz-ajuda",
		category: "jogos",
		reply: true,
		cooldown: 5,
		method: handleFazAjuda
	})
];

module.exports = {
	commands,
	getFarmWaifuRollBonus,
	consumeFarmWaifuRoll,
	getUserDisplayName,
	resolvePlayerRankingName,
	isTestUser,
	optimizeFarmImage,
	extractQualityFlag
};
