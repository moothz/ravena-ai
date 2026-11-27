/**
 * BichoGame.js
 *
 * Comandos do Jogo do Bicho na Ravena:
 * !bicho <modalidade/palpite> <valor> [cabeca|cercado] - Fazer aposta
 * !bicho tabela - Tabela oficial dos 25 bichos e dezenas
 * !bicho apostas - Minhas apostas abertas e histórico
 * !bicho resultado - Último resultado sorteado
 * !bicho avisos on/off - Configurar avisos automáticos no grupo
 */
"use strict";

const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const BichoService = require("../services/BichoService");
const { ANIMALS } = require("../services/bichoRules");

const bichoService = BichoService.getInstance();

async function handleBicho(bot, message, args) {
	const userId = message.author;
	const userName = message.authorName;
	const groupId = message.group;

	// Sem argumentos: ajuda e status
	if (!args || args.length === 0) {
		const config = await bichoService.getConfig();
		const lastDraw = await bichoService.getLastDraw();
		const { drawDate, isToday } = bichoService.calculateTargetDrawDate(config);

		let txt = `🎲 *JOGO DO BICHO — RAVENA* 🎲\n\n`;
		txt += `Aposte em Runas (ᚱ) e concorra na extração oficial das *${String(config.drawHour).padStart(2, "0")}:${String(config.drawMinute).padStart(2, "0")} BRT*!\n\n`;
		txt += `📅 *Próximo sorteio:* ${drawDate} ${isToday ? "(Hoje)" : "(Amanhã)"}\n`;
		txt += `⏰ *Apostas encerram às:* ${String(config.cutoffHour).padStart(2, "0")}:${String(config.cutoffMinute).padStart(2, "0")} BRT\n`;
		txt += `💰 *Aposta:* ${config.minBet.toLocaleString("pt-BR")} ᚱ a ${config.maxBet.toLocaleString("pt-BR")} ᚱ (Teto: ${(config.maxBet * config.maxPayoutMultiplier).toLocaleString("pt-BR")} ᚱ)\n\n`;
		txt += `📋 *Como Apostar:*\n`;
		txt += `• \`!bicho <bicho> <valor>\` (ex: \`!bicho jacare 1000\`)\n`;
		txt += `• \`!bicho dezena <00-99> <valor>\` (ex: \`!bicho dezena 42 2000\`)\n`;
		txt += `• \`!bicho centena <000-999> <valor>\` (ex: \`!bicho centena 342 1000\`)\n`;
		txt += `• \`!bicho milhar <0000-9999> <valor>\` (ex: \`!bicho milhar 1234 1000 cercado\`)\n\n`;
		txt += `💡 Adicione \`cercado\` ao final para jogar do 1º ao 5º prêmio!\n`;
		txt += `🔍 Veja a tabela de animais com: \`!bicho tabela\`\n`;
		txt += `🎟️ Veja suas apostas com: \`!bicho apostas\`\n`;

		if (lastDraw) {
			txt += `\n🏆 *Última Extração (${lastDraw.draw_date}):*\n`;
			txt += `1º Prêmio: ${lastDraw.prizes[0].number} — ${lastDraw.prizes[0].animalEmoji} ${lastDraw.prizes[0].animalName}`;
		}

		return [new ReturnMessage({ content: txt, options: { quotedMessageId: message.id } })];
	}

	const sub = String(args[0]).toLowerCase();

	if (["tabela", "t", "bichos"].includes(sub)) {
		return handleTabela(bot, message);
	}
	if (["apostas", "minhas", "historico"].includes(sub)) {
		return handleMinhasApostas(bot, message);
	}
	if (["resultado", "ultimo", "res"].includes(sub)) {
		return handleResultado(bot, message);
	}
	if (["avisos", "notificacao", "notificacoes"].includes(sub)) {
		return handleAvisos(bot, message, args.slice(1));
	}

	// É uma aposta!
	const res = await bichoService.placeBet({
		userId,
		userName,
		groupId,
		rawArgs: args
	});

	if (!res.success) {
		return [
			new ReturnMessage({ content: `❌ ${res.error}`, options: { quotedMessageId: message.id } })
		];
	}

	let receipt = `🎟️ *BILHETE REGISTRADO COM SUCESSO!* 🎟️\n\n`;
	receipt += `• *Bilhete nº:* #${res.betId}\n`;
	receipt += `• *Apostador:* ${userName}\n`;
	receipt += `• *Modalidade:* ${res.modality.toUpperCase()} (${res.scope === "cabeca" ? "1º Prêmio / Cabeça" : "Cercado 1º ao 5º"})\n`;
	receipt += `• *Palpite:* ${res.pick}\n`;
	receipt += `• *Valor Apostado:* ${res.amount.toLocaleString("pt-BR")} ᚱ\n`;
	receipt += `• *Prêmio Máximo Potencial:* ${res.potentialPayout.toLocaleString("pt-BR")} ᚱ${res.capped ? " *(Limitado pelo Teto da Banca)*" : ""}\n`;
	receipt += `• *Concorre na Extração:* ${res.drawDate} ${res.isToday ? "(Hoje às 19:00 BRT)" : "(Amanhã às 19:00 BRT)"}\n`;
	receipt += `\nBoa sorte! O resultado sairá às 19:00 BRT.`;

	return [new ReturnMessage({ content: receipt, options: { quotedMessageId: message.id } })];
}

async function handleTabela(bot, message) {
	let txt = `📋 *TABELA OFICIAL DO JOGO DO BICHO* 📋\n\n`;
	for (const a of ANIMALS) {
		const grp = String(a.group).padStart(2, "0");
		const tens = a.tens.join(", ");
		txt += `*${grp}* ${a.emoji} *${a.name}:* ${tens}\n`;
	}
	txt += `\nPara apostar: \`!bicho <nome ou grupo> <valor>\``;
	return [new ReturnMessage({ content: txt, options: { quotedMessageId: message.id } })];
}

async function handleMinhasApostas(bot, message) {
	const userId = message.author;
	const bets = await bichoService.getUserBets(userId, 8);

	if (!bets || bets.length === 0) {
		return [
			new ReturnMessage({
				content: "Você ainda não possui apostas registradas no Jogo do Bicho.",
				options: { quotedMessageId: message.id }
			})
		];
	}

	let txt = `🎟️ *SUAS ÚLTIMAS APOSTAS NO BICHO* 🎟️\n\n`;
	for (const b of bets) {
		const statusIcon =
			b.status === "OPEN"
				? "⏳ Aberta"
				: b.status === "WON"
					? `✅ Ganhou (${b.payout.toLocaleString("pt-BR")} ᚱ)`
					: "❌ Não premiada";
		txt += `• *#${b.id}* [${b.draw_date}] ${b.modality.toUpperCase()} *${b.pick}* (${b.scope})\n`;
		txt += `  Aposta: ${b.amount.toLocaleString("pt-BR")} ᚱ | Status: ${statusIcon}\n`;
	}

	return [new ReturnMessage({ content: txt, options: { quotedMessageId: message.id } })];
}

async function handleResultado(bot, message) {
	const lastDraw = await bichoService.getLastDraw();
	if (!lastDraw) {
		return [
			new ReturnMessage({
				content: "Nenhum sorteio foi realizado ainda.",
				options: { quotedMessageId: message.id }
			})
		];
	}

	const txt = bichoService.formatDrawResultText(lastDraw);
	return [new ReturnMessage({ content: txt, options: { quotedMessageId: message.id } })];
}

async function handleAvisos(bot, message, subArgs) {
	const isGroup =
		message.group &&
		(message.group.includes("@g.us") ||
			message.group.startsWith("-") ||
			message.group.length >= 17);
	if (!isGroup) {
		return [
			new ReturnMessage({
				content: "Os avisos automáticos só podem ser configurados dentro de grupos.",
				options: { quotedMessageId: message.id }
			})
		];
	}

	const opt = String(subArgs[0] || "").toLowerCase();
	if (!["on", "off", "ligar", "desligar", "ativar", "desativar"].includes(opt)) {
		return [
			new ReturnMessage({
				content:
					"Use: `!bicho avisos on` para receber o resultado diário das 19h no grupo, ou `!bicho avisos off` para desativar.",
				options: { quotedMessageId: message.id }
			})
		];
	}

	const enable = ["on", "ligar", "ativar"].includes(opt);
	await bichoService.setGroupSubscription(message.group, enable, bot.id);

	return [
		new ReturnMessage({
			content: enable
				? "✅ *Avisos ativados!* Este grupo receberá o resultado oficial do Jogo do Bicho todos os dias às 19:00 BRT."
				: "❌ *Avisos desativados!* Este grupo não receberá mais os resultados diários do Jogo do Bicho.",
			options: { quotedMessageId: message.id }
		})
	];
}

const commands = [
	new Command({
		name: "bicho",
		aliases: ["jb", "jogodobicho"],
		description: "Jogue no clássico Jogo do Bicho usando Runas",
		usage: "!bicho <bicho/palpite> <valor> [cercado]",
		category: "jogos",
		method: handleBicho
	}),
	new Command({
		name: "bicho-tabela",
		aliases: ["bichotabela", "tabelabicho"],
		description: "Exibe a tabela oficial dos 25 bichos e suas dezenas",
		usage: "!bicho-tabela",
		category: "jogos",
		method: (bot, msg) => handleTabela(bot, msg)
	}),
	new Command({
		name: "bicho-apostas",
		aliases: ["bichoapostas", "minhasapostas"],
		description: "Consulta suas apostas abertas e histórico recente do Jogo do Bicho",
		usage: "!bicho-apostas",
		category: "jogos",
		method: (bot, msg) => handleMinhasApostas(bot, msg)
	}),
	new Command({
		name: "bicho-resultado",
		aliases: ["bichoresultado", "resultadobicho"],
		description: "Consulta o resultado da última extração oficial do Jogo do Bicho",
		usage: "!bicho-resultado",
		category: "jogos",
		method: (bot, msg) => handleResultado(bot, msg)
	}),
	new Command({
		name: "bicho-avisos",
		aliases: ["bichoavisos"],
		description: "Ativa ou desativa a notificação diária do sorteio no grupo",
		usage: "!bicho-avisos <on|off>",
		category: "jogos",
		adminOnly: true,
		method: (bot, msg, args) => handleAvisos(bot, msg, args)
	})
];

module.exports = { commands };
