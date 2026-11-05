/**
 * BankCommands.js
 *
 * Módulo de comandos para o sistema financeiro central "RavenaBank".
 * Categoria: ravenabank
 */

const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const bankService = require("../services/BankService");
const ShadowGardenClient = require("../services/ShadowGardenClient");

const logger = new Logger("bank-commands");
const database = Database.getInstance();
const jardimClient = new ShadowGardenClient();

const BOT_DOMAIN = (process.env.BOT_DOMAIN || "https://ravena.moothz.com").replace(/\/+$/, "");

function formatPtBr(num, minDec = 2, maxDec = 2) {
	if (num === null || num === undefined || isNaN(num)) return "0";
	return Number(num).toLocaleString("pt-BR", {
		minimumFractionDigits: minDec,
		maximumFractionDigits: maxDec
	});
}

function getUserId(message) {
	return String(message.author || "").replace(/\D/g, "") || String(message.author || "");
}

function getChatId(message) {
	return message.group ?? message.author;
}

function isPrivateChat(message) {
	return !message.group;
}

/**
 * !banco: Consulta saldo de Runas, patrimônio consolidado e cotas do jogador
 */
async function handleBanco(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const account = await bankService.getAccount(userId);
		const quota = await bankService.getDailyQuota(userId);
		const rates = await bankService.getRates();

		// Busca saldos nos outros jogos
		let fishWeight = 0;
		try {
			const fishRow = await database.dbGet(
				"fishing",
				"SELECT SUM(weight) as w FROM fishing_inventory WHERE (user_id = ? OR user_id = ?) AND (is_rare = 0 OR is_rare IS NULL)",
				[message.author, userId]
			);
			fishWeight = fishRow?.w || 0;
		} catch (e) {}

		let zinthos = 0;
		try {
			const axios = require("axios");
			const wUrl = (process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030").replace(
				/\/+$/,
				""
			);
			const { data } = await axios.get(`${wUrl}/kakera/${userId}`, {
				headers: { Authorization: `Bearer ${process.env.WAIFULETES_API_KEY || ""}` },
				timeout: 4000
			});
			zinthos = data?.data?.balance ?? data?.data?.kakera ?? 0;
		} catch (e) {}

		let gardenCoins = 0;
		try {
			const status = await jardimClient.getStatus(userId);
			gardenCoins = status?.coins || 0;
		} catch (e) {}

		let text = `🏛️ *SUA CONTA NO RAVENABANK* 🏛️\n\n`;
		text += `💠 *Saldo de Runas:* \`${formatPtBr(account.runas, 2, 2)} ᚱ\`\n`;
		text += `📥 Total Vendido: \`${formatPtBr(account.total_deposited_runas, 2, 2)} ᚱ\`\n`;
		text += `📤 Total Comprado: \`${formatPtBr(account.total_withdrawn_runas, 2, 2)} ᚱ\`\n\n`;

		text += `🎮 *Seu Patrimônio:*\n`;
		text += `• 🎣 *Pesca:* ${formatPtBr(fishWeight, 2, 2)} kg\n`;
		text += `• 💜 *Waifuletes:* ${formatPtBr(zinthos, 0, 0)} Zinthos\n`;
		text += `• 🌱 *Jardim das Sombras:* ${formatPtBr(gardenCoins, 0, 0)} Ptl\n\n`;

		text += `🛡️ *Cotas Diárias Restantes:*\n`;
		text += `• 📥 Venda (Ganhar Runas): *${formatPtBr(quota.remaining.venda_runas, 2, 2)}* / ${formatPtBr(quota.limits.venda_runas, 0, 0)} ᚱ (unificado)\n`;
		text += `• 💜 Compra Zinthos: *${formatPtBr(quota.remaining.compra_zinthos, 0, 0)}* / ${formatPtBr(quota.limits.compra_zinthos, 0, 0)} Z\n`;
		text += `• 🌱 Compra Petalitas: *${formatPtBr(quota.remaining.compra_jardim, 0, 0)}* / ${formatPtBr(quota.limits.compra_jardim, 0, 0)} Ptl\n\n`;

		text += `💡 *Comandos Rápidos:*\n`;
		text += `• \`!banco-vender peixe <kg|tudo>\` — Vende peixes por Runas\n`;
		text += `• \`!banco-vender <zinthos|jardim> <qtd>\` — Vende zinthos e petalitas\n`;
		text += `• \`!banco-comprar <zinthos|jardim> <runas>\` — Compra zinthos e petalitas com Runas\n`;
		text += `• \`!banco-loja\` — Loja de moedas de Slots e iscas de Pesca\n`;
		text += `• \`!banco-comprar <moeda|isca> <qtd>\` — Compra consumíveis dos jogos\n`;
		text += `• \`!banco-adm\` — Link privado para gerenciar e trocar na web!\n`;
		text += `• \`!economia\` — Cotações do dia e explicações completas`;

		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		logger.error(`[handleBanco] Erro: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao consultar conta bancária: ${err.message}`
		});
	}
}

/**
 * !banco-adm: Envia link de acesso à área autenticada do web app com sessão deslizante de 3 dias
 */
async function handleBancoAdm(bot, message) {
	const userId = getUserId(message);
	const inPrivate = isPrivateChat(message);

	try {
		const session = await bankService.createSession(userId);
		const webUrl = `${BOT_DOMAIN}/ravenabank?token=${session.token}&_cb=${Date.now()}`;

		const content =
			`🔐 *ACESSO PESSOAL AO RAVENABANK WEB* 🔐\n\n` +
			`Acesse sua conta bancária e faça trocas direto pelo navegador:\n${webUrl}\n\n` +
			`⚠️ _Este link é pessoal e exclusivo. Cada acesso ou troca pelo navegador renova sua sessão automaticamente por mais 3 dias!_`;

		if (inPrivate) {
			return new ReturnMessage({
				chatId: message.author,
				content,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Se solicitado em grupo, envia no privado e apenas reage no grupo
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
			logger.debug(`[handleBancoAdm] Erro ao reagir: ${reactErr.message}`);
		}

		return null;
	} catch (err) {
		logger.error(`[handleBancoAdm] Erro: ${err.message}`);
		return new ReturnMessage({
			chatId: getChatId(message),
			content: `❌ Não foi possível gerar seu link de acesso: ${err.message}`
		});
	}
}

/**
 * !economia: Painel de cotações, inflações e regras do sistema
 */
async function handleEconomia(bot, message) {
	const chatId = getChatId(message);

	try {
		const macro = await bankService.getMacroEconomics();
		const rates = macro.rates;

		const kgPer1000 = Math.round(1000 / rates.runasPerKgFish);
		const zinthosPer1000 = Math.round(1000 / rates.runasPerZinthos);
		const jardimPer1000 = Math.round(1000 / rates.runasPerJardimCoin);

		let text = `🏛️ *PANORAMA ECONÔMICO GLOBAL — RAVENABANK* 🏛️\n`;
		text += `📅 Cotações Oficiais do Dia\n\n`;

		text += `💠 *COTAÇÃO DAS RUNAS (ᚱ):*\n`;
		text += `• 1.000 ᚱ = *${formatPtBr(kgPer1000, 0, 0)} kg de Peixe* (1 kg = ${formatPtBr(rates.runasPerKgFish, 2, 2)} ᚱ)\n`;
		text += `• 1.000 ᚱ = *${formatPtBr(zinthosPer1000, 0, 0)} Zinthos* (1 Z = ${formatPtBr(rates.runasPerZinthos, 4, 4)} ᚱ)\n`;
		text += `• 1.000 ᚱ = *${formatPtBr(jardimPer1000, 0, 0)} Petalitas* (1 Ptl = ${formatPtBr(rates.runasPerJardimCoin, 4, 4)} ᚱ)\n\n`;

		text += `📊 *ESTOQUES E TOTAIS ACUMULADOS:*\n`;
		text += `• 💠 *Runas:* ${formatPtBr(macro.totalRunas, 2, 2)} ᚱ em ${macro.totalAccounts} contas\n`;
		text += `• 🎣 *Peixes:* ${formatPtBr(macro.fish.totalCount, 0, 0)} peixes (${formatPtBr(macro.fish.totalWeight, 1, 1)} kg)\n`;
		text += `• 💜 *Zinthos:* ${formatPtBr(macro.waifu.circulatingZinthos, 0, 0)} Z (Inflação: +${macro.waifu.inflationPercent}%)\n`;
		text += `• 🌱 *Petalitas:* ${formatPtBr(macro.jardim.totalCoins, 0, 0)} Ptl\n\n`;

		text += `🛡️ *SOBRE O SISTEMA:*\n`;
		text += `1. *Taxa Progressiva:* É uma taxa (spread) que varia de *3% a 10%* com base na sua cota diária usada. Pequenos câmbios pagam a menor taxa; grandes trocas pagam taxa progressiva. Toda a taxa é destruída (deflação);\n`;
		text += `2. *Venda de Peixes:* Peixes podem ser vendidos por kg, não podem ser comprados com Runas. Peixes lendários não podem ser vendidos;\n`;
		text += `3. *Cotas Diárias:* Venda (ganhar Runas): Máx. ${formatPtBr(macro.rules.dailyLimits.venda_runas, 0, 0)} ᚱ (unificada de qualquer origem) | Compra Zinthos: Máx. ${formatPtBr(macro.rules.dailyLimits.compra_zinthos, 0, 0)} Z | Compra Petalitas: Máx. ${formatPtBr(macro.rules.dailyLimits.compra_jardim, 0, 0)} Ptl;\n`;
		text += `4. *Estabilidade:* A variação máxima diária de cotação é limitada a +-10% por segurança.\n\n`;

		text += `💡 _Para realizar trocas pelo navegador com facilidade, use \`!banco-adm\`!_`;

		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		logger.error(`[handleEconomia] Erro: ${err.message}`);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao consultar economia: ${err.message}`
		});
	}
}

/**
 * !banco-vender <peixe|zinthos|jardim> <quantidade|tudo>
 */
async function handleDepositar(bot, message, args) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	if (!args || args.length < 2) {
		return new ReturnMessage({
			chatId,
			content:
				`❌ *Uso incorreto!*\n\n` +
				`Exemplos:\n` +
				`• \`!banco-vender peixe 300\` (vende peixes até 300kg arredondando para baixo)\n` +
				`• \`!banco-vender peixe tudo\` (vende todos os peixes comuns do inventário)\n` +
				`• \`!banco-vender zinthos 1500\`\n` +
				`• \`!banco-vender jardim 5000\``
		});
	}

	const game = String(args[0]).toLowerCase().trim();
	const amountOrAll = String(args[1]).toLowerCase().trim();

	try {
		if (game === "peixe" || game === "pesca" || game === "peixes") {
			const res = await bankService.depositFish(userId, amountOrAll);
			let reply = `🎣 *VENDA DE PEIXES CONCLUÍDA!* ✨\n\n`;
			reply += `📦 *Meta Solicitada:* ${res.requestedKg === "tudo" ? "Todos os peixes comuns" : `${formatPtBr(res.requestedKg, 1, 2)} kg`}\n`;
			reply += `🐟 *Peixes Vendidos:* ${res.fishCount} peixes somando *${formatPtBr(res.soldKg, 2, 2)} kg*\n`;
			reply += `📈 *Taxa:* ${formatPtBr(res.spreadRate * 100, 1, 1)}% (-${formatPtBr(res.spreadFeeRunas, 2, 2)} ᚱ)\n`;
			reply += `💠 *Runas Creditadas:* *+${formatPtBr(res.netRunas, 2, 2)} ᚱ*\n`;
			reply += `✨ *Novo Saldo:* \`${formatPtBr(res.newBalance, 2, 2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de venda hoje: ${formatPtBr(res.quotaRemaining, 2, 2)} ᚱ`;

			return new ReturnMessage({
				chatId,
				content: reply,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		} else if (game === "zinthos" || game === "waifu" || game === "waifus") {
			const res = await bankService.depositZinthos(userId, amountOrAll);
			let reply = `💜 *VENDA DE ZINTHOS CONCLUÍDA!* ✨\n\n`;
			reply += `💎 *Zinthos Convertidos:* ${formatPtBr(res.amountDeposited, 0, 0)} Z\n`;
			reply += `📈 *Taxa:* ${formatPtBr(res.spreadRate * 100, 1, 1)}% (-${formatPtBr(res.spreadFeeRunas, 2, 2)} ᚱ)\n`;
			reply += `💠 *Runas Creditadas:* *+${formatPtBr(res.netRunas, 2, 2)} ᚱ*\n`;
			reply += `✨ *Novo Saldo no Banco:* \`${formatPtBr(res.newBalance, 2, 2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de venda hoje: ${formatPtBr(res.quotaRemaining, 2, 2)} ᚱ`;

			return new ReturnMessage({
				chatId,
				content: reply,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		} else if (
			game === "jardim" ||
			game === "fazenda" ||
			game === "petalita" ||
			game === "petalitas"
		) {
			const res = await bankService.depositJardim(userId, amountOrAll);
			let reply = `🌱 *VENDA DE PETALITAS CONCLUÍDA!* ✨\n\n`;
			reply += `🌱 *Petalitas Convertidas:* ${formatPtBr(res.amountDeposited, 0, 0)} Ptl\n`;
			reply += `📈 *Taxa:* ${formatPtBr(res.spreadRate * 100, 1, 1)}% (-${formatPtBr(res.spreadFeeRunas, 2, 2)} ᚱ)\n`;
			reply += `💠 *Runas Creditadas:* *+${formatPtBr(res.netRunas, 2, 2)} ᚱ*\n`;
			reply += `✨ *Novo Saldo no Banco:* \`${formatPtBr(res.newBalance, 2, 2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de venda hoje: ${formatPtBr(res.quotaRemaining, 2, 2)} ᚱ`;

			return new ReturnMessage({
				chatId,
				content: reply,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		} else {
			return new ReturnMessage({
				chatId,
				content: `❌ Jogo desconhecido: "${game}". Escolha entre: \`peixe\`, \`zinthos\` ou \`jardim\`.`
			});
		}
	} catch (err) {
		return new ReturnMessage({
			chatId,
			content: `❌ Falha na operação: ${err.message}`
		});
	}
}

/**
 * !banco-comprar <zinthos|jardim|moeda|isca> <quantidade>
 */
async function handleSacar(bot, message, args) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	if (!args || args.length < 1) {
		return new ReturnMessage({
			chatId,
			content:
				`❌ *Uso incorreto!*\n\n` +
				`Exemplos de Câmbio de Moedas:\n` +
				`• \`!banco-comprar zinthos 100\` (gasta 100 Runas e recebe Zinthos)\n` +
				`• \`!banco-comprar jardim 250\` (gasta 250 Runas e recebe Petalitas)\n\n` +
				`🛍️ *Loja RavenaBank (Consumíveis de Jogos):*\n` +
				`• \`!banco-comprar moeda 5\` (gasta 55 ᚱ cada moeda do Slots, máx 300/dia)\n` +
				`• \`!banco-comprar isca 3\` (gasta 45 ᚱ cada isca de Pesca, máx 200/dia)\n` +
				`• \`!banco-loja\` (exibe o catálogo completo da loja)\n\n` +
				`⚠️ _Nota: Não é possível comprar peixes com Runas._`
		});
	}

	const game = String(args[0]).toLowerCase().trim();

	if (game === "loja") {
		if (args.length >= 3) {
			const itemTarget = String(args[1]).toLowerCase().trim();
			const qtd = args[2];
			if (
				itemTarget === "moeda" ||
				itemTarget === "moedas" ||
				itemTarget === "slots" ||
				itemTarget === "ficha" ||
				itemTarget === "fichas"
			) {
				return await processBuyCoins(userId, chatId, qtd, message);
			} else if (itemTarget === "isca" || itemTarget === "iscas" || itemTarget === "pesca") {
				return await processBuyBaits(userId, chatId, qtd, message);
			}
		}
		return await handleLoja(bot, message);
	}

	if (args.length < 2) {
		if (
			game === "moeda" ||
			game === "moedas" ||
			game === "slots" ||
			game === "isca" ||
			game === "iscas"
		) {
			return new ReturnMessage({
				chatId,
				content: `❌ Informe a quantidade que deseja comprar. Exemplo: \`!banco-comprar ${game} 5\``
			});
		}
		return new ReturnMessage({
			chatId,
			content:
				`❌ *Uso incorreto!*\n\n` +
				`Exemplos:\n` +
				`• \`!banco-comprar zinthos 100\`\n` +
				`• \`!banco-comprar jardim 250\`\n` +
				`• \`!banco-comprar moeda 5\`\n` +
				`• \`!banco-comprar isca 3\``
		});
	}

	const amount = args[1];

	try {
		if (game === "peixe" || game === "peixes") {
			return new ReturnMessage({
				chatId,
				content:
					`❌ *Operação não permitida!*\n` +
					`Não é possível comprar peixes usando Runas. Peixes só podem ser vendidos para o banco.`
			});
		} else if (
			game === "moeda" ||
			game === "moedas" ||
			game === "slots" ||
			game === "ficha" ||
			game === "fichas"
		) {
			return await processBuyCoins(userId, chatId, amount, message);
		} else if (game === "isca" || game === "iscas") {
			return await processBuyBaits(userId, chatId, amount, message);
		} else if (game === "zinthos" || game === "waifu" || game === "waifus") {
			const res = await bankService.withdrawZinthos(userId, amount);
			let reply = `💜 *COMPRA DE ZINTHOS CONCLUÍDA!* ✨\n\n`;
			reply += `💠 *Runas Gastas:* ${formatPtBr(res.runasSpent, 2, 2)} ᚱ\n`;
			reply += `📈 *Taxa:* ${formatPtBr(res.spreadRate * 100, 1, 1)}%\n`;
			reply += `💎 *Zinthos Recebidos:* *+${formatPtBr(res.netZinthos, 0, 0)} Z*\n`;
			reply += `✨ *Saldo Restante no Banco:* \`${formatPtBr(res.newBalance, 2, 2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de Zinthos hoje: ${formatPtBr(res.quotaRemaining, 0, 0)} Z`;

			return new ReturnMessage({
				chatId,
				content: reply,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		} else if (
			game === "jardim" ||
			game === "fazenda" ||
			game === "petalita" ||
			game === "petalitas"
		) {
			const res = await bankService.withdrawJardim(userId, amount);
			let reply = `🌱 *COMPRA DE PETALITAS CONCLUÍDA!* ✨\n\n`;
			reply += `💠 *Runas Gastas:* ${formatPtBr(res.runasSpent, 2, 2)} ᚱ\n`;
			reply += `📈 *Taxa:* ${formatPtBr(res.spreadRate * 100, 1, 1)}%\n`;
			reply += `🌱 *Petalitas Recebidas:* *+${formatPtBr(res.netCoins, 0, 0)} Ptl*\n`;
			reply += `✨ *Saldo Restante no Banco:* \`${formatPtBr(res.newBalance, 2, 2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de Petalitas hoje: ${formatPtBr(res.quotaRemaining, 0, 0)} Ptl`;

			return new ReturnMessage({
				chatId,
				content: reply,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		} else {
			return new ReturnMessage({
				chatId,
				content: `❌ Destino de compra inválido: "${game}". Escolha entre: \`zinthos\`, \`jardim\`, \`moeda\` ou \`isca\`. Veja \`!banco-loja\` para mais detalhes.`
			});
		}
	} catch (err) {
		return new ReturnMessage({
			chatId,
			content: `❌ Falha na compra: ${err.message}`
		});
	}
}

async function processBuyCoins(userId, chatId, amount, message) {
	try {
		const res = await bankService.buySlotsCoins(userId, amount);
		let reply = `🎰 *COMPRA DE MOEDINHAS CONCLUÍDA!* ✨\n\n`;
		reply += `🪙 *Moedas Compradas:* *+${res.count}*\n`;
		reply += `💠 *Runas Gastas:* ${formatPtBr(res.costRunas, 2, 2)} ᚱ (300 ᚱ cada)\n`;
		reply += `🎰 *Saldo Atual no Slots:* ${res.currentCoins} / ${res.maxCoins} moedas\n`;
		reply += `✨ *Saldo Restante no Banco:* \`${formatPtBr(res.newBalance, 2, 2)} ᚱ\``;

		return new ReturnMessage({
			chatId,
			content: reply,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		return new ReturnMessage({
			chatId,
			content: `❌ Falha na compra de moedinhas: ${err.message}`
		});
	}
}

async function processBuyBaits(userId, chatId, amount, message) {
	try {
		const res = await bankService.buyFishingBaits(userId, amount);
		let reply = `🐛 *COMPRA DE ISCAS CONCLUÍDA!* ✨\n\n`;
		reply += `🎣 *Iscas Compradas:* *+${res.count}*\n`;
		reply += `💠 *Runas Gastas:* ${formatPtBr(res.costRunas, 2, 2)} ᚱ (100 ᚱ cada)\n`;
		reply += `🐛 *Saldo Atual na Pesca:* ${res.currentBaits} / ${res.limitBaits} iscas (capacidade: ${res.maxBaits})\n`;
		reply += `✨ *Saldo Restante no Banco:* \`${formatPtBr(res.newBalance, 2, 2)} ᚱ\``;

		return new ReturnMessage({
			chatId,
			content: reply,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		return new ReturnMessage({
			chatId,
			content: `❌ Falha na compra de iscas: ${err.message}`
		});
	}
}

/**
 * !banco-loja: Exibe a loja de consumíveis do RavenaBank
 */
async function handleLoja(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const catalog = await bankService.getStoreCatalog(userId);
		let text = `🏪 *LOJA RAVENABANK* 🛍️\n`;
		text += `Gaste suas Runas para adquirir consumíveis nos jogos!\n\n`;
		text += `💰 *Seu Saldo:* \`${formatPtBr(catalog.userRunas, 2, 2)} ᚱ\`\n\n`;

		for (const item of catalog.items) {
			text += `${item.emoji} *${item.name}*\n`;
			text += `• Preço: *${formatPtBr(item.priceRunas, 0, 0)} ᚱ* cada\n`;
			text += `• Saldo atual: *${item.current}*\n`;
			text += `• Limite diário: *${item.dailyLimit} /dia* (usado hoje: ${item.dailyUsed})\n`;
			text += `• Disponível para compra hoje: *${item.maxCanBuy}*\n`;
			if (item.id === "moedas") {
				text += `• Comando: \`!banco-comprar moeda <quantidade>\`\n\n`;
			} else {
				text += `• Comando: \`!banco-comprar isca <quantidade>\`\n\n`;
			}
		}

		text += `💡 *Exemplos de compra:*\n`;
		text += `• \`!banco-comprar moeda 5\`\n`;
		text += `• \`!banco-comprar isca 3\``;

		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		return new ReturnMessage({
			chatId,
			content: `❌ Falha ao abrir a loja: ${err.message}`
		});
	}
}

/**
 * !banco-extrato: Lista as últimas transações do jogador
 */
async function handleExtrato(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const [snapshot, txs] = await Promise.all([
			bankService.getDailyBalanceSnapshot(userId),
			bankService.getTransactions(userId, 6)
		]);

		let text = `📜 *EXTRATO BANCÁRIO — RAVENABANK*\n\n`;
		text += `💰 *Saldo Anterior (04:00):* \`${formatPtBr(snapshot.previousRunas, 2, 2)} ᚱ\`\n`;
		text += `💠 *Saldo Atual:* \`${formatPtBr(snapshot.currentRunas, 2, 2)} ᚱ\`\n\n`;

		if (!txs || txs.length === 0) {
			text += `_Você ainda não realizou movimentações no RavenaBank hoje._`;
			return new ReturnMessage({
				chatId,
				content: text,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		text += `📋 *Últimas Movimentações:*\n`;
		for (const t of txs) {
			const dateStr = new Date(t.timestamp).toLocaleDateString("pt-BR", {
				day: "2-digit",
				month: "2-digit",
				hour: "2-digit",
				minute: "2-digit"
			});
			const isVenda = t.type === "DEPOSIT";
			const emoji = isVenda ? "📥" : "📤";
			const sign = isVenda ? "+" : "-";
			const gameLabel =
				t.game === "pesca" ? "🎣 Pesca" : t.game === "waifu" ? "💜 Waifuletes" : "🌱 Petalitas";
			const unit = t.game === "pesca" ? "kg" : t.game === "jardim" ? "Ptl" : "Z";

			text += `${emoji} *${isVenda ? "Venda" : "Compra"} (${gameLabel})* — ${dateStr}\n`;
			text += `   • Movimentação: ${formatPtBr(t.game_amount, t.game === "pesca" ? 2 : 0, t.game === "pesca" ? 2 : 0)} ${unit} ➔ *${sign}${formatPtBr(t.runas_amount, 2, 2)} ᚱ*\n`;
			text += `   • Taxa: ${formatPtBr(t.spread_rate * 100, 1, 1)}% (-${formatPtBr(t.spread_fee_runas, 2, 2)} ᚱ)\n\n`;
		}

		return new ReturnMessage({
			chatId,
			content: text.trim(),
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao consultar extrato: ${err.message}`
		});
	}
}

// ─── DEFINIÇÃO DOS COMANDOS EXPORTADOS (CATEGORIA RAVENABANK) ───────────────

const commands = [
	new Command({
		name: "banco",
		aliases: ["ravenabank", "saldo-banco"],
		description: "Consulta seu saldo de Runas, patrimônio e cotas no RavenaBank",
		category: "ravenabank",
		group: "bank-core",
		cooldown: 3,
		reply: true,
		reactions: { before: "🏛️", after: "✨", error: "❌" },
		method: handleBanco
	}),
	new Command({
		name: "banco-adm",
		aliases: ["bancoadm", "banco-web"],
		description: "Envia link seguro no PV para gerenciar conta e trocar moedas pela web",
		category: "ravenabank",
		group: "bank-adm",
		cooldown: 3,
		reply: true,
		reactions: { before: "⏳", after: "🔗", error: "❌" },
		method: handleBancoAdm
	}),
	new Command({
		name: "economia",
		aliases: ["cotacao", "banco-economia"],
		description: "Panorama econômico, cotações do dia das Runas e regras do sistema",
		category: "ravenabank",
		group: "bank-eco",
		cooldown: 3,
		reply: true,
		reactions: { before: "📊", after: "📈", error: "❌" },
		method: handleEconomia
	}),
	new Command({
		name: "banco-vender",
		aliases: ["banco-depositar", "vender-peixe"],
		description: "Vende peixes, Zinthos ou Petalitas para o banco e recebe Runas",
		usage: "!banco-vender <peixe|zinthos|jardim> <quantidade|tudo>",
		category: "ravenabank",
		group: "bank-vender",
		cooldown: 3,
		reply: true,
		reactions: { before: "⏳", after: "💰", error: "❌" },
		method: handleDepositar
	}),
	new Command({
		name: "banco-comprar",
		aliases: ["banco-sacar", "banco-resgatar"],
		description: "Usa Runas para comprar Zinthos, Petalitas, Moedinhas do Slots ou Iscas",
		usage: "!banco-comprar <zinthos|jardim|moeda|isca> <quantidade>",
		category: "ravenabank",
		group: "bank-comprar",
		cooldown: 3,
		reply: true,
		reactions: { before: "⏳", after: "💸", error: "❌" },
		method: handleSacar
	}),
	new Command({
		name: "banco-loja",
		aliases: ["loja-banco"],
		description: "Exibe a loja de itens e consumíveis compráveis com Runas",
		usage: "!banco-loja",
		category: "ravenabank",
		group: "bank-loja",
		cooldown: 3,
		reply: true,
		reactions: { before: "⏳", after: "🏪", error: "❌" },
		method: handleLoja
	}),
	new Command({
		name: "banco-extrato",
		aliases: ["extrato", "extrato-banco"],
		description: "Consulta o histórico das suas últimas transações no RavenaBank",
		category: "ravenabank",
		group: "bank-extrato",
		cooldown: 3,
		reply: true,
		reactions: { before: "📜", after: "📋", error: "❌" },
		method: handleExtrato
	})
];

const helper = {
	about: "Sistema central de economia e câmbio entre os mini-games da Ravena via Runas",
	implementation:
		"Câmbio dinâmico com ancoragem nas Runas, rotação diária às 04:00 AM BRT, taxa progressiva (3% a 10%) e web app integrado",
	tags: "banco,ravenabank,runas,cambio,economia,pesca,zinthos,waifu,jardim,petalita,trocas",
	cmds: [
		{
			cmd: "!banco",
			desc: "Consulta saldo em Runas, patrimônio disponível em todos os jogos e cotas diárias",
			usage: ["!banco"],
			category: "ravenabank"
		},
		{
			cmd: "!banco-adm",
			desc: "Gera e envia link pessoal seguro para gerenciar e trocar moedas diretamente no navegador",
			usage: ["!banco-adm"],
			category: "ravenabank"
		},
		{
			cmd: "!economia",
			desc: "Exibe panorama macroeconômico, cotações do dia das Runas, taxa e regras do sistema",
			usage: ["!economia", "!cotacao"],
			category: "ravenabank"
		},
		{
			cmd: "!banco-vender <peixe|zinthos|jardim> <qtd|tudo>",
			desc: "Vende recursos dos mini-games para receber Runas",
			usage: ["!banco-vender peixe 300", "!banco-vender peixe tudo", "!banco-vender zinthos 1500"],
			category: "ravenabank"
		},
		{
			cmd: "!banco-comprar <zinthos|jardim|moeda|isca> <quantidade>",
			desc: "Usa Runas para comprar Zinthos, Petalitas, Moedinhas do Slots ou Iscas",
			usage: [
				"!banco-comprar zinthos 100",
				"!banco-comprar jardim 250",
				"!banco-comprar moeda 5",
				"!banco-comprar isca 3"
			],
			category: "ravenabank"
		},
		{
			cmd: "!banco-loja",
			desc: "Exibe a loja de consumíveis (moedas e iscas) compráveis com Runas",
			usage: ["!banco-loja"],
			category: "ravenabank"
		},
		{
			cmd: "!banco-extrato",
			desc: "Exibe extrato recente de vendas e compras no RavenaBank",
			usage: ["!banco-extrato"],
			category: "ravenabank"
		}
	]
};

module.exports = {
	commands,
	helper
};
