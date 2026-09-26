const path = require("path");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const DonorBonusService = require("../services/DonorBonusService");
const fs = require("fs").promises;

const logger = new Logger("donation-commands");
const database = Database.getInstance();

//logger.info('Módulo DonationCommands carregado');

/**
 * Lê o arquivo de cabeçalho dos donates
 * @returns {Promise<string>} - Conteúdo do cabeçalho
 */
async function readDonationHeader(bot) {
	try {
		const headerPath = path.join(database.databasePath, "textos", "donate_header.txt");
		const headerContent = await fs.readFile(headerPath, "utf8");
		return headerContent;
	} catch (error) {
		logger.warn("Erro ao ler cabeçalho do donate:", error);
		return `💖 *Ajuda de custos _${bot?.nomeExibir || "ravenabot"}_!* 🐦‍⬛\n\n`;
	}
}

/**
 * Lê o arquivo de rodapé dos donates
 * @returns {Promise<string>} - Conteúdo do rodapé
 */
async function readDonationFooter() {
	try {
		const headerPath = path.join(database.databasePath, "textos", "donate_footer.txt");
		const headerContent = await fs.readFile(headerPath, "utf8");
		return headerContent;
	} catch (error) {
		logger.warn("Erro ao ler footer do donate:", error);
		return "";
	}
}

/**
 * Formata o tempo passado desde um timestamp.
 * @param {number} timestamp - O timestamp em milissegundos.
 * @returns {string} - String formatada, ex: "ontem", "há 2 dias".
 */
function formatTimeAgo(timestamp) {
	if (!timestamp) return "Data desconhecida";
	const now = new Date();
	const past = new Date(timestamp);

	// Intl.RelativeTimeFormat é uma API nativa do JS para formatação de tempo relativo.
	const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

	const diffInSeconds = Math.floor((now - past) / 1000);

	const days = Math.round(diffInSeconds / 86400);
	if (days > 0) return rtf.format(-days, "day");

	const hours = Math.round(diffInSeconds / 3600);
	if (hours > 0) return rtf.format(-hours, "hour");

	const minutes = Math.round(diffInSeconds / 60);
	if (minutes > 0) return rtf.format(-minutes, "minute");

	return `agora mesmo`;
}

/**
 * Mostra status da meta de doação (se configurada)
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com informações da meta
 */
async function showDonationGoal(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		// Verifica se a meta de doação está configurada
		const goalAmount = process.env.DONATION_GOAL_AMOUNT;
		const goalDescription = process.env.DONATION_GOAL_DESCRIPTION;

		if (!goalAmount || isNaN(parseFloat(goalAmount))) {
			return new ReturnMessage({
				chatId,
				content: "Nenhuma meta de doação está definida atualmente."
			});
		}

		// Obtém todas as doações
		const donations = await database.getDonations();

		// Calcula total de doações
		const totalAmount = donations.reduce((total, donation) => total + donation.valor, 0);

		// Calcula porcentagem
		const goalAmountNum = parseFloat(goalAmount);
		const percentage = Math.min(100, Math.floor((totalAmount / goalAmountNum) * 100));

		// Cria barra de progresso
		const barLength = 20;
		const filledLength = Math.floor((percentage / 100) * barLength);
		const progressBar = "█".repeat(filledLength) + "░".repeat(barLength - filledLength);

		// Constrói mensagem
		let goalMsg =
			`🎯 *Meta de Doação* 🎯\n\n` +
			`Atual: R$${totalAmount.toFixed(2)} / Meta: R$${goalAmountNum.toFixed(2)}\n` +
			`[${progressBar}] ${percentage}%\n\n`;

		if (goalDescription) {
			goalMsg += `*Meta:* ${goalDescription}\n\n`;
		}

		goalMsg += `Use !donate ou !doar para nos ajudar a alcançar nossa meta!`;

		logger.debug("Informações de meta de doação enviadas com sucesso");

		return new ReturnMessage({
			chatId,
			content: goalMsg
		});
	} catch (error) {
		logger.error("Erro ao enviar informações de meta de doação:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "Erro ao recuperar informações de meta de doação. Por favor, tente novamente."
		});
	}
}

/**
 * Mostra lista dos principais doadores
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com lista de doadores
 */
async function showTopDonors(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		// Obtém todas as doações
		const donations = await database.getDonations();

		if (!donations || donations.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Nenhuma doação foi recebida ainda. Seja o primeiro a doar!"
			});
		}

		// 1. Encontra a última doação absoluta
		let lastDonationEntry = null;
		let lastDonorName = "";

		donations.forEach((donor) => {
			if (donor.historico && donor.historico.length > 0) {
				const donorLatest = donor.historico.reduce((latest, h) =>
					h.ts > (latest.ts || 0) ? h : latest
				);
				if (!lastDonationEntry || donorLatest.ts > lastDonationEntry.ts) {
					lastDonationEntry = donorLatest;
					lastDonorName = donor.nome;
				}
			} else if (donor.timestamp) {
				if (!lastDonationEntry || donor.timestamp > (lastDonationEntry.ts || 0)) {
					lastDonationEntry = { ts: donor.timestamp, valor: donor.valor };
					lastDonorName = donor.nome;
				}
			}
		});

		const timeSinceLastDonation = lastDonationEntry ? formatTimeAgo(lastDonationEntry.ts) : "Nunca";
		const lastDonationInfo = lastDonationEntry
			? `, por *${lastDonorName}* _(R$${lastDonationEntry.valor.toFixed(2)})_`
			: "";

		// 2. Calcula doações dos últimos 3 meses a partir do histórico
		const threeMonthsAgo = new Date();
		threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
		const threeMonthsAgoTs = threeMonthsAgo.getTime();

		let totalRecentAmount = 0;
		const recentDonorsSummary = {};

		donations.forEach((donor) => {
			const recentAmount = (donor.historico ?? [])
				.filter((h) => h.ts > threeMonthsAgoTs)
				.reduce((sum, h) => sum + h.valor, 0);

			// Fallback: se não há histórico, mas o timestamp principal é recente, usa o valor total.
			// É uma forma de lidar com dados antigos que ainda não têm histórico.
			if (
				recentAmount === 0 &&
				(!donor.historico || donor.historico.length === 0) &&
				donor.timestamp &&
				donor.timestamp > threeMonthsAgoTs
			) {
				const fallbackAmount = donor.valor;
				if (fallbackAmount > 0) {
					totalRecentAmount += fallbackAmount;
					recentDonorsSummary[donor.nome] = { nome: donor.nome, valor: fallbackAmount };
				}
			} else if (recentAmount > 0) {
				totalRecentAmount += recentAmount;
				recentDonorsSummary[donor.nome] = { nome: donor.nome, valor: recentAmount };
			}
		});

		const topRecentDonors = Object.values(recentDonorsSummary).sort((a, b) => b.valor - a.valor);
		//.slice(0, 5);

		// Ordena doações por valor (maior primeiro) para a lista geral
		donations.sort((a, b) => b.valor - a.valor);

		// Limita aos 1000 principais doadores
		const topDonors = donations.slice(0, 1000);

		// Calcula porcentagem da meta de 150
		const goalAmount = 150;
		const percentage = Math.min(100, Math.floor((totalRecentAmount / goalAmount) * 100));

		// Constrói mensagem
		let donorsMsg = await readDonationHeader(bot);

		// Adiciona as novas seções
		donorsMsg += `🕙 A última doação foi recebida ${timeSinceLastDonation}${lastDonationInfo}.\n\n`;
		donorsMsg += `💰 *Últimos 3 meses:* R$${totalRecentAmount.toFixed(2)} (${percentage}% da meta)\n`;
		donorsMsg += `Entre energia do servidor, recargas e outros gastos, estimo um gasto mensal por volta dos R$50. _Toda ajuda é bem vinda!_\n\n`;

		if (topRecentDonors.length > 0) {
			donorsMsg += "🏆 *Top Doadores (Últimos 3 meses):*\n";
			topRecentDonors.forEach((donor, index) => {
				donorsMsg += `${index + 1}. *${donor.nome}*: R$${donor.valor.toFixed(2)}\n`;
			});
			donorsMsg += "\n";
		}

		donorsMsg += "🏆 *Top Doadores (Desde o início):*\n";

		// Adiciona a lista geral de doadores
		topDonors.forEach((donor, index) => {
			const emjNumero = donor.numero?.length > 5 ? "" : " ❗️";
			donorsMsg += `${index + 1}. *${donor.nome}*: R$${donor.valor.toFixed(2)}${emjNumero}\n`;
		});

		donorsMsg += await readDonationFooter();

		logger.debug("Lista de principais doadores enviada com sucesso");

		return new ReturnMessage({
			chatId,
			content: donorsMsg
		});
	} catch (error) {
		logger.error("Erro ao enviar lista de principais doadores:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "Erro ao recuperar informações de doadores. Por favor, tente novamente."
		});
	}
}

/**
 * Mostra as vantagens de doação e benefícios acumulados do usuário
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>}
 */
async function showDonationPerks(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		const userId = message.author ?? message.authorAlt;

		const donor = await DonorBonusService.getDonorByUserId(userId);
		const isDonor = Boolean(donor && donor.valor > 0);

		let msg = `✨ *VANTAGENS & BÔNUS PARA APOIADORES* ✨\n\n`;
		msg += `Suas doações cobrem os custos de manutenção da Ravena _(servidores, APIs, números e recargas)_ e garantem bônus incríveis em todos os jogos!\n\n`;

		msg += `🎣 *Pescaria:*\n`;
		msg += `• *2 Iscas* no balde a cada R$ 1 doado.\n`;
		msg += `• *1 Item Simples* a cada R$ 5 doados _(Anzol de Titânio, Bolso de Pesca ou Pochete de Iscas)_.\n`;
		msg += `• *1 Item Médio* ao doar R$ 20 ou mais _(Calça de Pesca ou Caixa de Iscas)_.\n`;
		msg += `• *1 Item Alto* ao doar R$ 30 ou mais _(Mochilão ou Viveiro Portátil)_.\n`;
		msg += `• *Itens Altos Extras:* 1 item alto aos R$ 50 + 1 extra a cada R$ 10 acima de 50!\n\n`;

		msg += `🎰 *Caça-Níqueis (Slots):*\n`;
		msg += `• *3 Moedas* a cada R$ 1 doado _(sem limite de teto nos bônus!)_.\n\n`;

		msg += `🌸 *Waifus (Mudae):*\n`;
		msg += `• *Abaixo de R$ 50:* +2% de chance em Raros, +3.5% em Épicos e +4.5% em Lendários por R$ 1.\n`;
		msg += `• *A partir de R$ 50:* Desbloqueia *Super Wishlist* (+300% base + 8% por R$ 1 acima de 50)!\n`;
		msg += `• *Aos R$ 100:* Lendários atingem ~8% de chance e Wishlist chega a 8x (+700%)!\n`;
		msg += `• *!mu-chances exclusivo:* Mostra suas probabilidades personalizadas ativas.\n\n`;

		msg += `🩺 *Jogo do Pinto:*\n`;
		msg += `• *+1% de tamanho* em todos os atributos a cada R$ 1 doado _(respeitando os limites máximos)_.\n\n`;

		msg += `👑 *Vantagens Gerais no Bot:*\n`;
		msg += `• Aceite prioritário e automático de convites da Ravena para seus grupos.\n`;
		msg += `• Proteção contra restrições de convites.\n`;
		msg += `• Destaque no ranking geral de doadores com \`!doadores\`.\n\n`;
		msg += `──────────────\n\n`;

		if (isDonor) {
			const totalAmount = Number(donor.valor) || 0;
			const bonuses = DonorBonusService.calculateBonuses(totalAmount);

			msg += `💖 *Você é um apoiador! Agradeço de coração sua ajuda e por acreditar no projeto.*\n\n`;
			msg += `📊 *Seus Benefícios Acumulados (Total doado: R$ ${totalAmount.toFixed(2)}):*\n\n`;

			msg += `⚡ *Bônus Efêmeros Concedidos:*\n`;
			msg += `  • 🐛 *${bonuses.pesca.baits}* iscas de pesca entregues no seu balde.\n`;
			msg += `  • 🪙 *${bonuses.slots.coins}* moedas entregues no seu cofrinho de slots.\n\n`;

			msg += `🛡️ *Equipamentos & Bônus Fixos da Pesca:*\n`;
			msg += `  • 🔩 *${bonuses.pesca.simpleItemsCount}* itens simples sorteados.\n`;
			msg += `  • 👖 *${bonuses.pesca.mediumItemsCount}* item médio sorteado.\n`;
			msg += `  • 🎒 *${bonuses.pesca.totalHighItems}* itens de elite/altos sorteados.\n\n`;

			msg += `💎 *Bônus Ativos nos Sorteios de Waifus:*\n`;
			msg += `  • 🔵 Raros: *+${Math.round(totalAmount * 2.0)}%* | 🟣 Épicos: *+${Math.round(totalAmount * 3.5)}%* | ⭐ Lendários: *+${Math.round(totalAmount * 4.5)}%*\n`;
			if (bonuses.waifu.wishlistMultiplier) {
				const wishPct = Math.round((bonuses.waifu.wishlistMultiplier - 1) * 100);
				msg += `  • 🌟 Wishlist: *+${wishPct}%* de multiplicador (${bonuses.waifu.wishlistMultiplier.toFixed(1)}x)!\n`;
			} else {
				msg += `  • 🌟 Wishlist VIP: _Desbloqueada ao atingir R$ 50 no total!_\n`;
			}

			msg += `\n🩺 *Bônus no !pinto:* +${bonuses.pinto.bonusPercent}% de potencial estético!\n`;
		} else {
			msg += `🤍 *Você ainda não é um apoiador, mas sem pressão! Qualquer ajuda é bem vinda, mas completamente opcional.*\n\n`;
			msg += `🔗 Para doar e apoiar o projeto, digite \`!doar\` para obter o link do tipa.ai e a chave Pix!`;
		}

		return new ReturnMessage({
			chatId,
			content: msg,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando showDonationPerks:", error);
		const chatId = message.group ?? message.author;
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao consultar vantagens de doação. Por favor, tente novamente."
		});
	}
}

// Lista de comandos usando a classe Command
const commands = [
	new Command({
		name: "doar",
		description: "Mostra informações de doação e link",
		category: "geral",
		method: showTopDonors
	}),
	new Command({
		name: "doadores",
		description: "Mostra informações de doação e link",
		category: "geral",
		method: showTopDonors,
		hidden: true
	}),
	new Command({
		name: "donate",
		description: "Mostra informações de doação e link",
		category: "geral",
		method: showTopDonors,
		hidden: true
	}),
	new Command({
		name: "doar-vantagens",
		description: "Mostra todas as vantagens, bônus para doadores e seus benefícios acumulados",
		category: "geral",
		method: showDonationPerks
	}),
	new Command({
		name: "vantagens",
		description: "Alias de !doar-vantagens",
		category: "geral",
		method: showDonationPerks,
		hidden: true
	}),
	new Command({
		name: "bonus-doar",
		description: "Alias de !doar-vantagens",
		category: "geral",
		method: showDonationPerks,
		hidden: true
	}),
	new Command({
		name: "vantagens-doar",
		description: "Alias de !doar-vantagens",
		category: "geral",
		method: showDonationPerks,
		hidden: true
	})
];

const helper = {
	about: "Informações sobre doações, apoio financeiro e vantagens exclusivas para apoiadores",
	implementation:
		"Exibe opções de apoio (Pix, QR Code, Tipa.ai) e calcula vantagens nos jogos (Pesca, Slots, Waifus, Pinto)",
	tags: "doar,doacao,pix,ajuda,apoiar,crowdfunding,vantagens,bonus",
	cmds: [
		{
			cmd: "!doar",
			desc: "Exibe as opções de doação e chave Pix para apoiar o projeto",
			usage: ["!doar"],
			category: "geral"
		},
		{
			cmd: "!doar-vantagens",
			desc: "Exibe todas as vantagens e bônus de doadores e o que você já ganhou",
			usage: ["!doar-vantagens", "!vantagens"],
			category: "geral"
		}
	]
};

module.exports = {
	helper,
	commands,
	showDonationPerks
};
