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
		text += `✨ *Saldo de Runas:* \`${account.runas.toFixed(2)} ᚱ\`\n`;
		text += `📥 Total Depositado: \`${account.total_deposited_runas.toFixed(2)} ᚱ\`\n`;
		text += `📤 Total Sacado: \`${account.total_withdrawn_runas.toFixed(2)} ᚱ\`\n\n`;

		text += `🎮 *Seu Patrimônio Disponível nos Jogos:*\n`;
		text += `• 🎣 *Pesca Comum:* ${fishWeight.toFixed(2)} kg (venda de mão única)\n`;
		text += `• 💜 *Waifuletes:* ${zinthos.toLocaleString("pt-BR")} Zinthos\n`;
		text += `• 🌱 *Jardim das Sombras:* ${gardenCoins.toLocaleString("pt-BR")} Moedas\n\n`;

		text += `🛡️ *Cotas Diárias Restantes (Reset às 04:00 AM):*\n`;
		text += `• 🎣 Pesca: *${quota.remaining.pesca.toFixed(1)}* / ${quota.limits.pesca} kg\n`;
		text += `• 💜 Zinthos: *${quota.remaining.zinthos.toLocaleString("pt-BR")}* / ${quota.limits.zinthos.toLocaleString("pt-BR")} Z\n`;
		text += `• 🌱 Jardim: *${quota.remaining.jardim.toLocaleString("pt-BR")}* / ${quota.limits.jardim.toLocaleString("pt-BR")} moedas\n\n`;

		text += `💡 *Comandos Rápidos:*\n`;
		text += `• \`!banco-depositar peixe <kg|tudo>\` — Vende peixes por Runas\n`;
		text += `• \`!banco-depositar <zinthos|jardim> <qtd>\` — Deposita moedas\n`;
		text += `• \`!banco-sacar <zinthos|jardim> <runas>\` — Converte Runas em moedas\n`;
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
		const webUrl = `${BOT_DOMAIN}/ravenabank?token=${session.token}`;

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
 * !economia: Painel transparente de cotações, inflações e regras
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
		text += `📅 Cotação Oficial do Dia (Rotação diária às 04:00 AM BRT)\n\n`;

		text += `✨ *COTAÇÃO OFICIAL DAS RUNAS (ᚱ):*\n`;
		text += `• 1.000 ᚱ = *${kgPer1000.toLocaleString("pt-BR")} kg de Peixe* (1 kg = ${rates.runasPerKgFish.toFixed(2)} ᚱ)\n`;
		text += `• 1.000 ᚱ = *${zinthosPer1000.toLocaleString("pt-BR")} Zinthos* (1 Z = ${rates.runasPerZinthos.toFixed(4)} ᚱ)\n`;
		text += `• 1.000 ᚱ = *${jardimPer1000.toLocaleString("pt-BR")} Moedas do Jardim* (1 MJ = ${rates.runasPerJardimCoin.toFixed(4)} ᚱ)\n\n`;

		text += `📊 *ESTOQUES E MACROECONOMIA EM TEMPO REAL:*\n`;
		text += `• ᚱ *Massa Total de Runas:* ${macro.totalRunas.toFixed(2)} ᚱ em ${macro.totalAccounts} contas\n`;
		text += `• 🎣 *Peixes Comuns em Inventários:* ${macro.fish.totalCount.toLocaleString("pt-BR")} peixes (${macro.fish.totalWeight.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} kg)\n`;
		text += `• 💜 *Massa de Zinthos (M2):* ${macro.waifu.circulatingZinthos.toLocaleString("pt-BR")} Z (Inflação: +${macro.waifu.inflationPercent}%)\n`;
		text += `• 🌱 *Moedas no Jardim das Sombras:* ${macro.jardim.totalCoins.toLocaleString("pt-BR")} moedas\n\n`;

		text += `🛡️ *COMO FUNCIONA O SISTEMA (TRANSPARÊNCIA TOTAL):*\n`;
		text += `1. *Spread Progressivo:* Varia de *3% a 10%* com base na sua cota diária usada. Pequenos câmbios pagam a menor taxa; grandes trocas pagam spread progressivo. Todo o spread é destruído (deflação).\n`;
		text += `2. *Venda de Peixes (Mão Única):* Peixes podem ser vendidos por aproximação para baixo (knapsack). Peixes lendários são 100% protegidos contra venda. Não é permitido converter Runas para peixes.\n`;
		text += `3. *Cotas Diárias (24h):* Máx. ${macro.rules.dailyLimits.pesca.toLocaleString("pt-BR")} kg peixe | ${macro.rules.dailyLimits.zinthos.toLocaleString("pt-BR")} Zinthos | ${macro.rules.dailyLimits.jardim.toLocaleString("pt-BR")} Moedas Jardim.\n`;
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
 * !banco-depositar <peixe|zinthos|jardim> <quantidade|tudo>
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
				`• \`!banco-depositar peixe 300\` (vende peixes até 300kg arredondando para baixo)\n` +
				`• \`!banco-depositar peixe tudo\` (vende todos os peixes comuns do inventário)\n` +
				`• \`!banco-depositar zinthos 1500\`\n` +
				`• \`!banco-depositar jardim 5000\``
		});
	}

	const game = String(args[0]).toLowerCase().trim();
	const amountOrAll = String(args[1]).toLowerCase().trim();

	try {
		if (game === "peixe" || game === "pesca" || game === "peixes") {
			const res = await bankService.depositFish(userId, amountOrAll);
			let reply = `🎣 *VENDA DE PEIXES CONCLUÍDA!* ✨\n\n`;
			reply += `📦 *Meta Solicitada:* ${res.requestedKg === "tudo" ? "Todos os peixes comuns" : `${res.requestedKg} kg`}\n`;
			reply += `🐟 *Peixes Vendidos:* ${res.fishCount} peixes somando *${res.soldKg} kg*\n`;
			reply += `📈 *Taxa de Spread:* ${(res.spreadRate * 100).toFixed(1)}% (-${res.spreadFeeRunas.toFixed(2)} ᚱ queimadas)\n`;
			reply += `💰 *Runas Creditadas:* *+${res.netRunas.toFixed(2)} ᚱ*\n`;
			reply += `✨ *Novo Saldo no Banco:* \`${res.newBalance.toFixed(2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de pesca hoje: ${res.quotaRemaining.toFixed(1)} kg`;

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
			let reply = `💜 *DEPÓSITO DE ZINTHOS CONCLUÍDO!* ✨\n\n`;
			reply += `💎 *Zinthos Convertidos:* ${res.amountDeposited.toLocaleString("pt-BR")} Z\n`;
			reply += `📈 *Taxa de Spread:* ${(res.spreadRate * 100).toFixed(1)}% (-${res.spreadFeeRunas.toFixed(2)} ᚱ queimadas)\n`;
			reply += `💰 *Runas Creditadas:* *+${res.netRunas.toFixed(2)} ᚱ*\n`;
			reply += `✨ *Novo Saldo no Banco:* \`${res.newBalance.toFixed(2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de Zinthos hoje: ${res.quotaRemaining.toLocaleString("pt-BR")} Z`;

			return new ReturnMessage({
				chatId,
				content: reply,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		} else if (game === "jardim" || game === "fazenda") {
			const res = await bankService.depositJardim(userId, amountOrAll);
			let reply = `🌱 *DEPÓSITO DO JARDIM CONCLUÍDO!* ✨\n\n`;
			reply += `🌾 *Moedas Convertidas:* ${res.amountDeposited.toLocaleString("pt-BR")} moedas\n`;
			reply += `📈 *Taxa de Spread:* ${(res.spreadRate * 100).toFixed(1)}% (-${res.spreadFeeRunas.toFixed(2)} ᚱ queimadas)\n`;
			reply += `💰 *Runas Creditadas:* *+${res.netRunas.toFixed(2)} ᚱ*\n`;
			reply += `✨ *Novo Saldo no Banco:* \`${res.newBalance.toFixed(2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante do Jardim hoje: ${res.quotaRemaining.toLocaleString("pt-BR")} moedas`;

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
 * !banco-sacar <zinthos|jardim> <quantidade de runas>
 */
async function handleSacar(bot, message, args) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	if (!args || args.length < 2) {
		return new ReturnMessage({
			chatId,
			content:
				`❌ *Uso incorreto!*\n\n` +
				`Exemplos:\n` +
				`• \`!banco-sacar zinthos 100\` (gasta 100 Runas e recebe Zinthos)\n` +
				`• \`!banco-sacar jardim 250\` (gasta 250 Runas e recebe Moedas do Jardim)\n\n` +
				`⚠️ _Nota: Não é possível converter Runas em peixes._`
		});
	}

	const game = String(args[0]).toLowerCase().trim();
	const runasAmount = args[1];

	try {
		if (game === "peixe" || game === "pesca" || game === "peixes") {
			return new ReturnMessage({
				chatId,
				content:
					`❌ *Operação não permitida!*\n` +
					`Não é possível converter Runas em peixes. Peixes só podem ser vendidos para o banco.`
			});
		} else if (game === "zinthos" || game === "waifu" || game === "waifus") {
			const res = await bankService.withdrawZinthos(userId, runasAmount);
			let reply = `💜 *RESGATE DE ZINTHOS CONCLUÍDO!* ✨\n\n`;
			reply += `ᚱ *Runas Gastas:* ${res.runasSpent.toFixed(2)} ᚱ\n`;
			reply += `📈 *Taxa de Spread:* ${(res.spreadRate * 100).toFixed(1)}%\n`;
			reply += `💎 *Zinthos Recebidos:* *+${res.netZinthos.toLocaleString("pt-BR")} Z*\n`;
			reply += `✨ *Saldo Restante no Banco:* \`${res.newBalance.toFixed(2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante de Zinthos hoje: ${res.quotaRemaining.toLocaleString("pt-BR")} Z`;

			return new ReturnMessage({
				chatId,
				content: reply,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		} else if (game === "jardim" || game === "fazenda") {
			const res = await bankService.withdrawJardim(userId, runasAmount);
			let reply = `🌱 *RESGATE DO JARDIM CONCLUÍDO!* ✨\n\n`;
			reply += `ᚱ *Runas Gastas:* ${res.runasSpent.toFixed(2)} ᚱ\n`;
			reply += `📈 *Taxa de Spread:* ${(res.spreadRate * 100).toFixed(1)}%\n`;
			reply += `🌾 *Moedas Recebidas:* *+${res.netCoins.toLocaleString("pt-BR")} moedas*\n`;
			reply += `✨ *Saldo Restante no Banco:* \`${res.newBalance.toFixed(2)} ᚱ\`\n\n`;
			reply += `🛡️ Cota restante do Jardim hoje: ${res.quotaRemaining.toLocaleString("pt-BR")} moedas`;

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
				content: `❌ Destino de saque inválido: "${game}". Escolha entre: \`zinthos\` ou \`jardim\`.`
			});
		}
	} catch (err) {
		return new ReturnMessage({
			chatId,
			content: `❌ Falha no saque: ${err.message}`
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
		const txs = await bankService.getTransactions(userId, 6);
		if (!txs || txs.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `📜 *EXTRATO BANCÁRIO*\n\nVocê ainda não realizou movimentações no RavenaBank.`
			});
		}

		let text = `📜 *EXTRATO RECENTE — RAVENABANK*\n\n`;
		for (const t of txs) {
			const dateStr = new Date(t.timestamp).toLocaleDateString("pt-BR", {
				day: "2-digit",
				month: "2-digit",
				hour: "2-digit",
				minute: "2-digit"
			});
			const isDeposit = t.type === "DEPOSIT";
			const emoji = isDeposit ? "📥" : "📤";
			const sign = isDeposit ? "+" : "-";
			const gameLabel =
				t.game === "pesca" ? "🎣 Pesca" : t.game === "waifu" ? "💜 Waifus" : "🌱 Jardim";

			text += `${emoji} *${t.type === "DEPOSIT" ? "Depósito" : "Saque"} (${gameLabel})* — ${dateStr}\n`;
			text += `   • Movimentação: ${t.game_amount} ${t.game === "pesca" ? "kg" : "unid."} ➔ *${sign}${t.runas_amount.toFixed(2)} ᚱ*\n`;
			text += `   • Spread: ${(t.spread_rate * 100).toFixed(1)}% (-${t.spread_fee_runas.toFixed(2)} ᚱ)\n\n`;
		}

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
			content: `❌ Erro ao consultar extrato: ${err.message}`
		});
	}
}

// ─── DEFINIÇÃO DOS COMANDOS EXPORTADOS (CATEGORIA RAVENABANK) ───────────────

const commands = [
	new Command({
		name: "banco",
		aliases: ["ravenabank", "saldo-banco", "meu-banco"],
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
		aliases: ["bancoadm", "banco-web", "bancoweb"],
		description: "Envia link seguro no PV para gerenciar conta e trocar moedas pela web (3 dias)",
		category: "ravenabank",
		group: "bank-core",
		cooldown: 10,
		reply: true,
		reactions: { before: "⏳", after: "🔗", error: "❌" },
		method: handleBancoAdm
	}),
	new Command({
		name: "economia",
		aliases: ["banco-economia", "banco-cotacao", "cotacao", "bancocotacao"],
		description: "Panorama macroeconômico, cotações do dia das Runas e transparência de regras",
		category: "ravenabank",
		group: "bank-core",
		cooldown: 5,
		reply: true,
		reactions: { before: "📊", after: "📈", error: "❌" },
		method: handleEconomia
	}),
	new Command({
		name: "banco-depositar",
		aliases: ["banco-dep", "banco-vender-peixe", "banco-vender-peixes"],
		description: "Deposita peixes, Zinthos ou Moedas do Jardim no banco e recebe Runas",
		usage: "!banco-depositar <peixe|zinthos|jardim> <quantidade|tudo>",
		category: "ravenabank",
		group: "bank-trade",
		cooldown: 3,
		reply: true,
		reactions: { before: "⏳", after: "💰", error: "❌" },
		method: handleDepositar
	}),
	new Command({
		name: "banco-sacar",
		aliases: ["banco-saque", "banco-resgatar"],
		description: "Converte Runas do banco em Zinthos ou Moedas do Jardim",
		usage: "!banco-sacar <zinthos|jardim> <runas>",
		category: "ravenabank",
		group: "bank-trade",
		cooldown: 3,
		reply: true,
		reactions: { before: "⏳", after: "💸", error: "❌" },
		method: handleSacar
	}),
	new Command({
		name: "banco-extrato",
		aliases: ["extrato-banco", "extrato"],
		description: "Consulta o histórico das suas últimas transações no RavenaBank",
		category: "ravenabank",
		group: "bank-core",
		cooldown: 5,
		reply: true,
		reactions: { before: "📜", after: "📋", error: "❌" },
		method: handleExtrato
	})
];

const helper = {
	about: "Sistema central de economia e câmbio entre os mini-games da Ravena via Runas",
	implementation:
		"Câmbio dinâmico com ancoragem nas Runas, rotação diária às 04:00 AM BRT, spread progressivo (3% a 10%), knapsack de peixes e web app integrado",
	tags: "banco,ravenabank,runas,cambio,economia,pesca,zinthos,waifu,jardim,trocas",
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
			desc: "Exibe panorama macroeconômico, cotações do dia das Runas, spread e regras transparentes",
			usage: ["!economia", "!banco-cotacao"],
			category: "ravenabank"
		},
		{
			cmd: "!banco-depositar <peixe|zinthos|jardim> <qtd|tudo>",
			desc: "Deposita recursos dos mini-games para receber Runas (peixes vendidos por aproximação)",
			usage: [
				"!banco-depositar peixe 300",
				"!banco-depositar peixe tudo",
				"!banco-depositar zinthos 1500"
			],
			category: "ravenabank"
		},
		{
			cmd: "!banco-sacar <zinthos|jardim> <runas>",
			desc: "Converte Runas em Zinthos do Waifuletes ou Moedas do Jardim das Sombras",
			usage: ["!banco-sacar zinthos 100", "!banco-sacar jardim 250"],
			category: "ravenabank"
		},
		{
			cmd: "!banco-extrato",
			desc: "Exibe extrato recente de conversões e depósitos no RavenaBank",
			usage: ["!banco-extrato"],
			category: "ravenabank"
		}
	]
};

module.exports = {
	commands,
	helper
};
