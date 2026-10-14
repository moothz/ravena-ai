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
async function handleFazenda(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const inPrivate = isPrivateChat(message);

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

		// 2. Busca status da fazenda
		const status = await jardimClient.getStatus(userId);

		// 3. Tenta renderizar imagem (se falhar, envia mensagem de texto sem derrubar o comando)
		let imageBuffer = null;
		try {
			imageBuffer = await jardimClient.getImageBuffer(userId, true);
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

		let text = `🌱 *JARDIM DAS SOMBRAS* 🌱\n\n`;
		text += `💰 *Moedas:* ${status.coins ?? 0}\n`;
		text += `🌾 *Canteiros (9):* ${readyCount} prontos | ${growingCount} crescendo | ${dryCount} secos | ${emptyCount} livres\n`;

		if (status.buffs?.activeBuffs?.length > 0) {
			text += `✨ *Buffs Ativos:* ${status.buffs.activeBuffs.map((b) => b.type).join(", ")}\n`;
		}

		text += `\n📖 *Comandos Rápidos:* \`!faz-colher\`, \`!faz-plantar\`, \`!faz-loja\`, \`!faz-inv\``;

		// Link público da fazenda
		const shareUrl =
			status.shareUrl || (status.uuid ? `https://jds.moothz.win/farm?id=${status.uuid}` : null);
		if (shareUrl) {
			text += `\n\n🌐 *Ver Fazenda Online:* ${shareUrl}`;
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
			returns.push(
				new ReturnMessage({
					chatId,
					content: {
						mimetype: "image/jpeg",
						data: imageBuffer.toString("base64"),
						filename: `fazenda-${userId}.jpg`,
						isMessageMedia: true
					},
					options: {
						caption: text
					}
				})
			);
		} else {
			returns.push(
				new ReturnMessage({
					chatId,
					content: text
				})
			);
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

			returns.push(
				new ReturnMessage({
					chatId,
					content: dailyText
				})
			);
		}

		return returns;
	} catch (err) {
		logger.error(`[handleFazenda] Erro ao carregar fazenda: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao acessar o Jardim das Sombras: ${err.message}`
		});
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
			return new ReturnMessage({
				chatId: message.author,
				content
			});
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
		return new ReturnMessage({
			chatId: getChatId(message),
			content: `❌ Não foi possível gerar seu link de acesso: ${err.message}`
		});
	}
}

/**
 * !faz-colher: Colhe plantas prontas e limpa canteiros secos
 */
async function handleFazColher(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message);

	const slotNum = args && /^\d+$/.test(args) ? parseInt(args, 10) : null;

	try {
		const harvestRes = await jardimClient.harvest(userId, slotNum, !slotNum);

		let text = `🌾 *COLHEITA DO JARDIM DAS SOMBRAS* 🌾\n\n`;

		const harvested = harvestRes.harvested || [];
		const withered = harvestRes.clearedWithered || harvestRes.withered || [];

		if (harvested.length === 0 && withered.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `⏳ Não há plantas prontas para colheita nem canteiros secos no momento.`
			});
		}

		if (harvested.length > 0) {
			text += `✨ *Itens Colhidos:*\n`;
			harvested.forEach((h) => {
				text += `• *${h.name || h.plantName || h.plantId}* (Canteiro #${h.slotIndex || h.slot})\n`;
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

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazColher] Erro na colheita: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha na colheita: ${err.message}`
		});
	}
}

/**
 * !faz-plantar: Planta sementes em canteiro específico ou em todos os canteiros livres
 */
async function handleFazPlantar(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content: `🌱 *Como plantar:*\n• \`!faz-plantar <semente>\` (planta em todos os canteiros livres)\n• \`!faz-plantar <semente> <canteiro>\` (ex: \`!faz-plantar 1 5\`)\n\nVeja suas sementes com \`!faz-inv\`.`
		});
	}

	const itemParam = args[0];
	const slotParam = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : null;

	try {
		const plantRes = await jardimClient.plant(userId, itemParam, slotParam, slotParam ? 1 : null);

		let text = `🌱 *PLANTIO REALIZADO COM SUCESSO!* 🌱\n\n`;
		const planted = plantRes.planted || (plantRes.slot ? [plantRes] : []);

		if (planted.length > 0) {
			planted.forEach((p) => {
				text += `• Canteiro #${p.slotIndex || p.slot}: *${p.name || p.plantName || itemParam}*\n`;
			});
		} else {
			text += `Planta(s) adicionadas com sucesso aos canteiros livres!\n`;
		}

		text += `\nConsulte o crescimento com \`!fazenda\`.`;
		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazPlantar] Erro ao plantar: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao plantar: ${err.message}`
		});
	}
}

/**
 * !faz-loja: Exibe sementes, elixires e decorações disponíveis para compra
 */
async function handleFazLoja(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const shop = await jardimClient.getShop(userId);

		let text = `🛒 *MERCADO DO JARDIM DAS SOMBRAS* 🛒\n\n`;

		if (shop.seeds?.length > 0) {
			text += `🌱 *SEMENTES:*\n`;
			shop.seeds.forEach((s) => {
				const rem =
					s.remainingToday !== undefined ? ` [${s.remainingToday}/${s.dailyLimit} hoje]` : "";
				text += `• *#${s.index} ${s.name}* — 💰 ${s.price} moedas (${s.growthMinutes}m)${rem}\n  _${s.description}_\n`;
			});
			text += "\n";
		}

		if (shop.consumables?.length > 0) {
			text += `🧪 *ELIXIRES & CONSUMÍVEIS:*\n`;
			shop.consumables.forEach((c) => {
				const rem =
					c.remainingToday !== undefined ? ` [${c.remainingToday}/${c.dailyLimit} hoje]` : "";
				text += `• *#${c.index} ${c.name}* — 💰 ${c.price} moedas${rem}\n  _${c.description}_\n`;
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

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazLoja] Erro ao carregar loja: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao carregar loja: ${err.message}`
		});
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
		return new ReturnMessage({
			chatId,
			content: `🛒 *Como comprar:*\n• \`!faz-comprar <id ou número do item> [quantidade]\`\nExemplo: \`!faz-comprar 1 5\` (compra 5 sementes do item #1)`
		});
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

		returns.push(
			new ReturnMessage({
				chatId,
				content: text
			})
		);

		// Se a API retornou o sticker WebP/PNG em Base64, envia como figurinha
		if (buyRes.stickerBase64) {
			const stickerMedia = {
				mimetype: "image/webp",
				data: buyRes.stickerBase64,
				filename: `sticker-${itemParam}.webp`,
				isMessageMedia: true
			};
			returns.push(
				new ReturnMessage({
					chatId,
					content: stickerMedia,
					options: {
						sendMediaAsSticker: true,
						stickerAuthor: bot?.nomeExibir || "ravena",
						stickerName: `Jardim: ${buyRes.itemName || itemParam}`,
						quotedMessageId: message.origin?.id?._serialized,
						goReply: message.origin
					}
				})
			);
		}

		return returns;
	} catch (err) {
		logger.error(`[handleFazComprar] Erro ao comprar: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha na compra: ${err.message}`
		});
	}
}

/**
 * !faz-inventario: Exibe o inventário do jogador (sementes, consumíveis, colheitas e decorações)
 */
async function handleFazInventario(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const inv = await jardimClient.getInventory(userId);

		let text = `🎒 *MOCHILA DO JARDIM DAS SOMBRAS* 🎒\n\n`;

		const items = inv.items || inv.inventory || [];
		if (items.length === 0) {
			text += `Sua mochila está completamente vazia no momento.\nVisite a loja com \`!faz-loja\` para adquirir sementes!`;
			return new ReturnMessage({ chatId, content: text });
		}

		const seeds = items.filter((i) => i.type === "seed" || i.category === "seed");
		const crops = items.filter((i) => i.type === "crop" || i.category === "crop");
		const consumables = items.filter((i) => i.type === "consumable" || i.category === "consumable");
		const decors = items.filter((i) => i.type === "decoration" || i.category === "decoration");

		if (seeds.length > 0) {
			text += `🌱 *Sementes:*\n`;
			seeds.forEach((s) => {
				text += `• ${s.name}: *${s.quantity}x*\n`;
			});
			text += "\n";
		}

		if (crops.length > 0) {
			text += `🌾 *Colheitas Prontas (Venda com !faz-vender):*\n`;
			crops.forEach((c) => {
				text += `• ${c.name}: *${c.quantity}x* (💰 ${c.sellPrice || 0} cada)\n`;
			});
			text += "\n";
		}

		if (consumables.length > 0) {
			text += `🧪 *Elixires & Poções:*\n`;
			consumables.forEach((c) => {
				text += `• ${c.name}: *${c.quantity}x*\n`;
			});
			text += "\n";
		}

		if (decors.length > 0) {
			text += `🏺 *Decorações:*\n`;
			decors.forEach((d) => {
				text += `• ${d.name}: *${d.quantity}x*\n`;
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

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazInventario] Erro ao carregar inventário: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao buscar inventário: ${err.message}`
		});
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
		return new ReturnMessage({
			chatId,
			content: `🧪 *Como usar um elixir:*\n• \`!faz-usar <id ou nome do elixir> [canteiro]\`\nExemplo: \`!faz-usar blood_ruby 1\``
		});
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

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazUsar] Erro ao usar elixir: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao usar item: ${err.message}`
		});
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

		let text = `💰 *VENDA REALIZADA COM SUCESSO!* 💰\n\n`;
		text += `• Moedas Ganhas: *+${sellRes.earnedCoins || sellRes.totalGained || 0} moedas*\n`;
		text += `• Saldo Atual: *${sellRes.currentCoins || sellRes.coins || 0} moedas*\n`;

		if (sellRes.soldItems?.length > 0) {
			text += `\nItens vendidos:\n`;
			sellRes.soldItems.forEach((it) => {
				text += `• ${it.name || it.itemId}: ${it.quantity}x\n`;
			});
		}

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazVender] Erro ao vender colheitas: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha na venda: ${err.message}`
		});
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
		return new ReturnMessage({
			chatId,
			content: `🏺 *Como posicionar enfeites:*\n• Por slot: \`!faz-decorar <enfeite> <slot de 1 a 4>\`\n• Por coordenadas: \`!faz-decorar <enfeite> <slot> <x> <y>\`\n• Por imagem: Marque um emoji sobre o terreno na foto da sua fazenda e envie respondendo: \`!faz-decorar <enfeite>\``
		});
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

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazDecorar] Erro ao posicionar enfeite: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao posicionar enfeite: ${err.message}`
		});
	}
}

/**
 * !faz-ranking: Exibe rankings de riqueza e de colheitas
 */
async function handleFazRanking(bot, message) {
	const chatId = getChatId(message);
	const args = getArgsText(message).toLowerCase();

	const isFarmers = args.includes("colheita") || args.includes("farmer");

	try {
		let text = "";
		if (isFarmers) {
			const farmers = await jardimClient.getFarmersRanking();
			text += `🏆 *TOP 10 MESTRES DA COLHEITA* 🏆\n\n`;
			const list = farmers.ranking || farmers || [];
			list.slice(0, 10).forEach((f, idx) => {
				text += `${idx + 1}º. @${f.userId || f.playerId} — *${f.harvestCount || f.totalHarvested || 0} colheitas*\n`;
			});
			text += `\n_Para ver o ranking de moedas, digite \`!faz-ranking riqueza\`_`;
		} else {
			const wealth = await jardimClient.getWealthRanking();
			text += `🏆 *TOP 10 FAZENDEIROS MAIS RICOS* 🏆\n\n`;
			const list = wealth.ranking || wealth || [];
			list.slice(0, 10).forEach((w, idx) => {
				text += `${idx + 1}º. @${w.userId || w.playerId} — 💰 *${w.coins || 0} moedas*\n`;
			});
			text += `\n_Para ver o ranking de colheitas, digite \`!faz-ranking colheitas\`_`;
		}

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		logger.error(`[handleFazRanking] Erro ao buscar rankings: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao carregar ranking: ${err.message}`
		});
	}
}

/**
 * !faz-ajuda: Guia geral dos comandos da Fazenda
 */
async function handleFazAjuda(bot, message) {
	const chatId = getChatId(message);

	const text =
		`🌱 *GUIA DO JARDIM DAS SOMBRAS* 🌱\n\n` +
		`• \`!fazenda\` — Ver a sua fazenda e resgatar Sacola do Coveiro diária\n` +
		`• \`!faz-adm\` — Obter link do painel web Farm Admin no privado\n` +
		`• \`!faz-colher\` — Colher plantas maduras e limpar canteiros secos\n` +
		`• \`!faz-plantar <semente> [canteiro]\` — Semear nos canteiros\n` +
		`• \`!faz-loja\` — Ver catálogo de sementes, elixires e decorações\n` +
		`• \`!faz-comprar <item> [qtd]\` — Comprar itens na loja\n` +
		`• \`!faz-inventario\` — Ver seus itens, sementes e bônus acumulados\n` +
		`• \`!faz-usar <elixir> [canteiro]\` — Ativar poções mágicas\n` +
		`• \`!faz-vender [item ou tudo]\` — Vender suas colheitas por moedas\n` +
		`• \`!faz-decorar <enfeite> [slot]\` — Posicionar itens decorativos\n` +
		`• \`!faz-ranking\` — Ver o ranking dos melhores fazendeiros\n` +
		`• \`!faz-ajuda\` — Exibir este menu de ajuda`;

	return new ReturnMessage({
		chatId,
		content: text
	});
}

// ─── DEFINIÇÃO DOS COMANDOS EXPORTADOS ──────────────────────────────────────

const commands = [
	// REMOVER_HIDDEN_NO_LANCAMENTO: Altere para 'hidden: false' quando o Jardim das Sombras for lançado oficialmente
	new Command({
		name: "fazenda",
		aliases: ["jardim"],
		description: "Visualiza a fazenda atual no Jardim das Sombras e coleta o diário",
		usage: "!fazenda",
		category: "jogos",
		hidden: true,
		cooldown: 5,
		method: handleFazenda
	}),
	new Command({
		name: "faz-adm",
		aliases: ["faz-admin"],
		description: "Gera o link de autenticação seguro para o painel Farm Admin",
		usage: "!faz-adm",
		category: "jogos",
		hidden: true,
		cooldown: 10,
		method: handleFazAdm
	}),
	new Command({
		name: "faz-colher",
		aliases: ["faz-colhertudo"],
		description: "Colhe plantas maduras e limpa canteiros secos",
		usage: "!faz-colher [número do canteiro]",
		category: "jogos",
		hidden: true,
		cooldown: 3,
		method: handleFazColher
	}),
	new Command({
		name: "faz-plantar",
		aliases: ["faz-plantartudo"],
		description: "Planta sementes em canteiro específico ou em todos os canteiros livres",
		usage: "!faz-plantar <semente> [canteiro]",
		category: "jogos",
		hidden: true,
		cooldown: 3,
		method: handleFazPlantar
	}),
	new Command({
		name: "faz-loja",
		aliases: ["faz-shop"],
		description: "Visualiza catálogo de sementes, elixires e decorações",
		usage: "!faz-loja",
		category: "jogos",
		hidden: true,
		cooldown: 5,
		method: handleFazLoja
	}),
	new Command({
		name: "faz-comprar",
		aliases: ["faz-buy"],
		description: "Compra sementes, elixires ou decorações da loja",
		usage: "!faz-comprar <item> [quantidade]",
		category: "jogos",
		hidden: true,
		cooldown: 3,
		method: handleFazComprar
	}),
	new Command({
		name: "faz-inventario",
		aliases: ["faz-inv"],
		description: "Exibe a mochila de itens, sementes e bônus acumulados",
		usage: "!faz-inventario",
		category: "jogos",
		hidden: true,
		cooldown: 3,
		method: handleFazInventario
	}),
	new Command({
		name: "faz-usar",
		aliases: ["faz-use"],
		description: "Utiliza um elixir ou consumível do inventário",
		usage: "!faz-usar <elixir> [canteiro]",
		category: "jogos",
		hidden: true,
		cooldown: 3,
		method: handleFazUsar
	}),
	new Command({
		name: "faz-vender",
		aliases: ["faz-vendertudo"],
		description: "Vende colheitas do inventário por moedas",
		usage: "!faz-vender [item ou tudo]",
		category: "jogos",
		hidden: true,
		cooldown: 3,
		method: handleFazVender
	}),
	new Command({
		name: "faz-decorar",
		aliases: ["faz-enfeitar"],
		description: "Posiciona ou reposiciona itens decorativos no terreno da fazenda",
		usage: "!faz-decorar <enfeite> [slot ou com imagem marcada]",
		category: "jogos",
		hidden: true,
		cooldown: 5,
		method: handleFazDecorar
	}),
	new Command({
		name: "faz-ranking",
		aliases: ["faz-rank"],
		description: "Exibe os rankings de riqueza ou mestres da colheita",
		usage: "!faz-ranking [riqueza|colheitas]",
		category: "jogos",
		hidden: true,
		cooldown: 5,
		method: handleFazRanking
	}),
	new Command({
		name: "faz-ajuda",
		aliases: ["faz-help"],
		description: "Exibe guia de comandos e mecânicas do Jardim das Sombras",
		usage: "!faz-ajuda",
		category: "jogos",
		hidden: true,
		cooldown: 5,
		method: handleFazAjuda
	})
];

module.exports = {
	commands,
	getFarmWaifuRollBonus,
	consumeFarmWaifuRoll
};
