const path = require("path");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
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
		method: showTopDonors
	}),
	new Command({
		name: "donate",
		description: "Mostra informações de doação e link",
		category: "geral",
		method: showTopDonors,
		hidden: true
	})
];

module.exports = { commands };
