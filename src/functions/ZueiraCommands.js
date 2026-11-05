const fs = require("fs");
const { createCanvas, loadImage } = require("canvas");
const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");

const Command = require("../models/Command");
const Database = require("../utils/Database");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");
const crypto = require("crypto");

const logger = new Logger("general-commands");

const database = Database.getInstance();
const variableProcessor = new CustomVariableProcessor();

const calcularDigitoCPF = (s) => {
	const r = s.split("").reduce((a, n, i) => a + parseInt(n) * (s.length + 1 - i), 0) % 11;
	return r < 2 ? 0 : 11 - r;
};

const gerarStringAleatoria = (
	tamanho,
	padZero = false,
	hexadecimal = false,
	qtdZeroPadding = 0
) => {
	let resultado;
	if (!hexadecimal && padZero) {
		resultado = crypto
			.randomInt(0, 10 ** tamanho)
			.toString()
			.padStart(tamanho, "0");
	} else {
		const chars = hexadecimal ? "0123456789abcdef" : "0123456789";
		resultado = Array.from(
			{ length: tamanho },
			() => chars[crypto.randomInt(0, chars.length)]
		).join("");
	}
	return "0".repeat(qtdZeroPadding) + resultado;
};

const gerarCpf = () => {
	const base = gerarStringAleatoria(9, true);
	const dig1 = calcularDigitoCPF(base);
	const dig2 = calcularDigitoCPF(base + dig1);
	return `${base.substring(0, 3)}.${base.substring(3, 6)}.${base.substring(6, 9)}-${dig1}${dig2}`;
};

function getNowBrasilia() {
	const now = new Date();
	const timeZone = process.env.TZ || "America/Sao_Paulo";
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	});
	const parts = dtf.formatToParts(now);
	const map = {};
	for (const p of parts) {
		map[p.type] = p.value;
	}
	return {
		hour: parseInt(map.hour, 10),
		hourStr: map.hour,
		minuteStr: map.minute,
		secondStr: map.second,
		dayStr: map.day,
		monthStr: map.month,
		yearStr: map.year
	};
}

const gerarDataHoraAtual = () => {
	const b = getNowBrasilia();
	return `${b.dayStr}/${b.monthStr}/${b.yearStr} às ${b.hourStr}:${b.minuteStr}`;
};

async function gerarTicket(dados) {
	const largura = 400;
	const canvas = createCanvas(largura, 900);
	const ctx = canvas.getContext("2d");
	let y = 0;

	ctx.fillStyle = "white";
	ctx.fillRect(0, 0, largura, 900);

	try {
		const img = await loadImage(path.join(database.databasePath, "ravenabank.png"));
		ctx.drawImage(img, (largura - img.width) / 2, 20);
		y = img.height + 40;
	} catch {
		Object.assign(ctx, { fillStyle: "#ccc", textAlign: "center" });
		ctx.fillRect((largura - 150) / 2, 20, 150, 60);
		ctx.fillStyle = "black";
		ctx.fillText("Imagem Topo", largura / 2, 55);
		y = 100;
	}

	Object.assign(ctx, { font: "bold 24px Arial", fillStyle: "black", textAlign: "center" });
	ctx.fillText("Comprovante Ravenabank", largura / 2, y);
	y += 40;
	ctx.font = "bold 18px Arial";
	ctx.fillStyle = "#28a745";
	ctx.fillText("✅ Pix Enviado com sucesso", largura / 2, y);
	y += 40;
	ctx.font = "bold 22px Arial";
	ctx.fillStyle = "black";
	ctx.fillText(dados.valor, largura / 2, y);
	y += 25;
	ctx.font = "16px Arial";
	ctx.fillText(dados.dataHora, largura / 2, y);
	y += 30;

	const desenharLinha = (yPos) => {
		ctx.beginPath();
		ctx.moveTo(20, yPos);
		ctx.lineTo(largura - 20, yPos);
		Object.assign(ctx, { strokeStyle: "#cccccc", lineWidth: 1 });
		ctx.stroke();
	};

	const secoes = [
		{
			titulo: "Recebedor",
			campos: [
				`Nome: ${dados.recebedor.nome}`,
				`CPF: ${dados.recebedor.cpf}`,
				`Agência: ${dados.recebedor.tipo}`,
				`Conta: ${dados.recebedor.conta}`,
				`Banco: Ravenabank`,
				`Chave PIX: ${dados.recebedor.hash}`
			]
		},
		{
			titulo: "Pagador",
			campos: [
				`Nome: ${dados.pagador.nome}`,
				`CPF: ${dados.pagador.cpf}`,
				`Agência: ${dados.pagador.tipo}`,
				`Conta: ${dados.pagador.conta}`,
				`Banco: Ravenabank`
			]
		},
		{ titulo: "Informações Adicionais", campos: [`ID: ${dados.infoAdicionais.id}`] }
	];

	secoes.forEach((secao) => {
		desenharLinha(y);
		y += 25;
		Object.assign(ctx, { font: "bold 16px Arial", fillStyle: "black", textAlign: "left" });
		ctx.fillText(secao.titulo, 20, y);
		y += 25;
		ctx.font = "14px Arial";
		secao.campos.forEach((campo) => {
			ctx.fillText(campo, 20, y);
			y += 20;
		});
		y += secao.titulo === "Informações Adicionais" ? 0 : 10;
	});

	desenharLinha(y);
	y += 25;
	ctx.textAlign = "left";
	ctx.font = "14px Arial";
	ctx.fillText(`Documento: ${dados.documento}`, 20, y);
	y += 20;
	ctx.fillText(`Autenticação: ${dados.autenticacao}`, 20, y);
	y += 20;

	desenharLinha(y);
	y += 30;
	Object.assign(ctx, { font: "bold 12px Arial", textAlign: "center" });
	ctx.fillText("Este é o seu comprovante, guarde com cuidado e não compartilhe", largura / 2, y);
	y += 25;
	ctx.font = "14px Arial";
	ctx.fillText(`ravena.moothz.com`, largura / 2, y);

	return canvas.toDataURL("image/png");
}

function formatarValorSimples(valor) {
	const valorPadronizado = String(valor).replace(",", ".");
	const numero = parseFloat(valorPadronizado);
	if (isNaN(numero)) {
		return "R$0,00";
	}
	const valorFormatado = numero.toFixed(2).replace(".", ",");
	return `R$${valorFormatado}`;
}

function encontrarPrimeiroNumero(args) {
	for (const item of args) {
		if (typeof item === "number" && isFinite(item)) {
			return { n: item, i: args.indexOf(item) };
		}

		if (typeof item === "string") {
			const strPadronizada = item.replace(",", ".");

			if (!isNaN(Number(strPadronizada)) && item.trim() !== "") {
				return { n: item, i: args.indexOf(item) };
			}
		}
	}

	return { n: 0, i: 1 };
}

async function pix(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	const options = {};
	const res = encontrarPrimeiroNumero(args);
	let valorPix = res.n;
	const iValor = res.i;

	const nomePagador = message.pushname ?? message.authorName ?? message.name ?? "Fulano";
	let nomeRecebedor = "Fulano";

	if (message.mentions?.length > 0) {
		// Primeiro argumento é um mention
		const cttRecebedor = await bot.client.getContactById(
			message.mentions[0] ?? message.goMessageData?.sender
		);
		if (cttRecebedor) {
			logger.debug(`[pix] cttRecebedor `, { cttRecebedor });
		}
		nomeRecebedor =
			cttRecebedor.name?.pushName ??
			cttRecebedor.name ??
			cttRecebedor.pushName ??
			cttRecebedor.pushname ??
			cttRecebedor.number ??
			"Fulano";
	} else if (!isFinite(args[0])) {
		// se não for mention nem numero, é um nome (chute)
		nomeRecebedor = args.slice(0, iValor).join(" ");
	}

	if (!valorPix) {
		valorPix = 50;
	}

	const dadosPix = {
		valor: formatarValorSimples(valorPix),
		dataHora: gerarDataHoraAtual(),
		recebedor: {
			nome: nomeRecebedor,
			cpf: gerarCpf(),
			tipo: `${gerarStringAleatoria(4)}-${gerarStringAleatoria(1)}`,
			conta: `${gerarStringAleatoria(6)}-${gerarStringAleatoria(1)}`,
			banco: "Ravenabank",
			hash: `${gerarStringAleatoria(8, false, true)}-${gerarStringAleatoria(4, false, true)}-${gerarStringAleatoria(4, false, true)}-${gerarStringAleatoria(4, false, true)}-${gerarStringAleatoria(12, false, true)}`
		},
		pagador: {
			nome: nomePagador,
			cpf: gerarCpf(),
			tipo: `${gerarStringAleatoria(4)}-${gerarStringAleatoria(1)}`,
			conta: `${gerarStringAleatoria(6)}-${gerarStringAleatoria(1)}`,
			banco: "Ravenabank"
		},
		infoAdicionais: { id: gerarStringAleatoria(16, false, false, 14) },
		documento: gerarStringAleatoria(5, false, false, 5),
		autenticacao: `1.${gerarStringAleatoria(5)}.${gerarStringAleatoria(7)}.${gerarStringAleatoria(6)}`
	};

	const comprovantePNG = await gerarTicket(dadosPix);
	const dadosb64 = comprovantePNG.split("base64,").at(-1);
	const comprovante = { mimetype: "image/png", data: dadosb64, isMessageMedia: true };

	const resposta = new ReturnMessage({
		chatId,
		content: comprovante,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			...options
		}
	});

	return resposta;
}

async function handleComandoVariavelSimples(bot, message, args, group, variavel) {
	const chatId = message.group ?? message.author;

	const customVariables = await database.getCustomVariables();
	const frases = customVariables[variavel];
	const fraseIndex = Math.floor(Math.random() * frases.length);

	const options = {};
	const fraseFinal = await variableProcessor.process(frases[fraseIndex], {
		message,
		group,
		options,
		bot
	});

	const resposta = new ReturnMessage({
		chatId,
		content: fraseFinal,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			...options
		}
	});

	return resposta;
}

// Rastreamento de boletos ativos em memória
const activeBoletos = new Map();
const paidBoletos = new Set();

function cleanOldBoletos() {
	const now = Date.now();
	for (const [key, val] of activeBoletos.entries()) {
		if (now - val.createdAt > 24 * 60 * 60 * 1000) {
			activeBoletos.delete(key);
		}
	}
	if (paidBoletos.size > 2000) {
		paidBoletos.clear();
	}
}

function recordBoletoMessage(msgId, data) {
	if (!msgId || !data) return;
	cleanOldBoletos();
	activeBoletos.set(msgId, {
		targetJid: data.targetJid || null,
		creatorJid: data.creatorJid || null,
		creatorName: data.creatorName || null,
		createdAt: Date.now(),
		paid: false
	});
}

async function handleBoletoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	const customVariables = await database.getCustomVariables();
	const frases = customVariables.boleto || [
		"*{mention}* foi escolhido pra pagar esse boleto para *{nomeAutor}* 😏😏\n___\n```B O Q U E T E```\n█║▌│║▌║▌│█│▌║│█│\n¹²³ ³² ²³¹ ¹ ¹²³² ³²¹ ³²³ ¹²³"
	];
	const fraseIndex = Math.floor(Math.random() * frases.length);

	const options = {};
	const fraseFinal = await variableProcessor.process(frases[fraseIndex], {
		message,
		group,
		options,
		bot
	});

	const creatorJid = message.authorAlt || message.author;
	const creatorName =
		message.authorName || message.name || (creatorJid ? creatorJid.split("@")[0] : "Alguém");
	const targetJid = (options.mentions && options.mentions[0]) || null;

	const boletoData = {
		targetJid,
		creatorJid,
		creatorName
	};

	const originMsgId = message.origin?.id?._serialized || message.origin?.id;
	if (originMsgId) {
		recordBoletoMessage(originMsgId, boletoData);
	}

	const resposta = new ReturnMessage({
		chatId,
		content: fraseFinal,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin,
			boletoData,
			...options
		}
	});

	return resposta;
}

const frasesPagamentoBoleto = [
	"Nossa, que delícia! 🤤\n@{payer} fez o pagamento do boleto{creator} com muita satisfação! 😋",
	"Ufa, que alívio! 🥵\n@{payer} quitou o boleto{creator} até a última gota com muito carinho! 🤤💦",
	"Ai sim! 🤤\n@{payer} pagou o boleto todinho{creator} sem deixar sobrar nem os centavos! 😋💋",
	"Que maravilha! 🤤\n@{payer} realizou o pagamento{creator} com dedicação e a boca cheia de vontade! 😋✨",
	"Nossa, que pagamento caprichado! 🤤\n@{payer} liquidou a fatura{creator} com toda a calma e muita satisfação! 🫦💦",
	"Pagamento confirmado na boca do caixa! 🏦🤤\n@{payer} honrou esse boleto{creator} com muito prazer e maestria! 😋",
	"Eita que delícia! 🥵\n@{payer} engoliu todos os encargos e quitou o boleto{creator} com o maior gosto! 🤤👅",
	"Comprovante emitido com sucesso! 🧾🤤\n@{payer} fez a liquidação completa desse boleto{creator} com total entrega e satisfação! 😋💦",
	"Hummm, que pagamento gostoso! 🤤\n@{payer} caprichou na quitação desse boleto{creator}! Ficou todo mundo satisfeito! 😋🔥",
	"Que delícia de transação! 🤤\n@{payer} pagou esse boleto{creator} de joelhos agradecendo a oportunidade! 🫦😋"
];

async function handlePagarBoleto(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	let quotedMsg = null;
	if (typeof message.origin?.getQuotedMessage === "function") {
		quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
	}
	if (!quotedMsg && message.origin?.quotedMsg) {
		quotedMsg = message.origin.quotedMsg;
	}
	if (!quotedMsg && message.quotedMsg) {
		quotedMsg = message.quotedMsg;
	}

	if (!quotedMsg) {
		return new ReturnMessage({
			chatId,
			content: "⚠️ Você precisa responder diretamente à mensagem do `!boleto` com `!pagar`!",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const quotedId =
		quotedMsg.id?._serialized || quotedMsg.id?.id || quotedMsg.id || quotedMsg.stanzaId;
	const quotedText =
		quotedMsg.body ||
		quotedMsg.content ||
		quotedMsg.caption ||
		(typeof quotedMsg.text === "string" ? quotedMsg.text : "") ||
		"";

	const boletoData = (quotedId && activeBoletos.get(quotedId)) || null;

	// Se não encontrou pelo ID no Map, verifica se o texto citado é característico de um boleto
	const isBoletoText =
		/B\s*O\s*Q\s*U\s*E\s*T\s*E|boleto|█║▌|foi escolhido pra pagar esse boleto/i.test(quotedText);

	if (!boletoData && !isBoletoText) {
		return new ReturnMessage({
			chatId,
			content: "⚠️ A mensagem respondida não parece ser um boleto!",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	// Extração de dados da mensagem citada caso não esteja no Map (ex: pós reinicialização)
	let targetJid = boletoData?.targetJid || null;
	const creatorJid = boletoData?.creatorJid || null;
	let creatorName = boletoData?.creatorName || null;

	if (!targetJid && quotedMsg.mentions && quotedMsg.mentions.length > 0) {
		targetJid = quotedMsg.mentions[0];
	}

	if (!targetJid && typeof quotedText === "string") {
		const match = quotedText.match(
			/\*@?([0-9a-zA-Z._-]+)\*\s+foi\s+escolhido\s+pra\s+pagar\s+esse\s+boleto(?:\s+para\s+\*([^*]+)\*)?/i
		);
		if (match) {
			const num = match[1].replace(/[@\s]/g, "");
			targetJid = num.includes("@") ? num : `${num}@s.whatsapp.net`;
			if (!creatorName && match[2]) {
				creatorName = match[2].trim();
			}
		}
	}

	if (boletoData?.paid || (quotedId && paidBoletos.has(quotedId))) {
		return new ReturnMessage({
			chatId,
			content: "😏 Esse boleto já foi pago e está quitadinho! Não precisa pagar de novo.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	// Validação: apenas a pessoa marcada pode pagar
	const senderJid = message.authorAlt || message.author;
	const senderClean = (senderJid || "").split("@")[0];
	const targetClean = targetJid ? targetJid.split("@")[0] : null;

	if (targetClean && senderClean !== targetClean) {
		const targetDisplay = `@${targetClean}`;
		return new ReturnMessage({
			chatId,
			content: `❌ Ei, esse boleto não é seu para pagar! Apenas ${targetDisplay} pode fazer esse pagamento! 😏`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Pagamento efetuado com sucesso!
	if (boletoData) boletoData.paid = true;
	if (quotedId) paidBoletos.add(quotedId);

	const fraseModelo =
		frasesPagamentoBoleto[Math.floor(Math.random() * frasesPagamentoBoleto.length)];

	const creatorSuffix = creatorName ? ` de *${creatorName}*` : "";
	const textoFinal = fraseModelo
		.replace("{payer}", senderClean)
		.replace("{creator}", creatorSuffix);

	const mentions = [senderJid];
	if (creatorJid && !mentions.includes(creatorJid)) {
		mentions.push(creatorJid);
	}

	return new ReturnMessage({
		chatId,
		content: textoFinal,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin,
			mentions
		}
	});
}

async function presente(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	const options = {};
	const fraseFinal = await variableProcessor.process(
		"*{nomeAutor}* deu _{presente}_ para *{mention}*! 🎁",
		{ message, group, options, bot }
	);

	const resposta = new ReturnMessage({
		chatId,
		content: fraseFinal,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			...options
		}
	});

	return resposta;
}

function getSaudacao(hora) {
	if (hora >= 5 && hora < 12) {
		return "Tenha um bom dia! ☀️";
	} else if (hora >= 12 && hora < 18) {
		return "Tenha uma boa tarde! ☀️";
	} else if (hora >= 18 && hora < 24) {
		return "Tenha uma boa noite! 🌙";
	} else {
		return "Tenha uma boa madrugada! 🌙";
	}
}

async function horaDataCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const { hour, hourStr } = getNowBrasilia();
	const saudacao = getSaudacao(hour);

	const template = `🕰️ Agora são aproximadamente exatos 🕒 {data-hora}:{data-minuto} do dia {data-dia}/{data-mes}/{data-ano} 🗓\n${saudacao}`;

	const options = {};
	const textoFinal = await variableProcessor.process(template, {
		message,
		group,
		options,
		bot
	});

	const retorno = [
		new ReturnMessage({
			chatId,
			content: textoFinal,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				...options
			}
		})
	];

	const audioPath = path.join(database.databasePath, "assets", `horacerta_${hourStr}.mp3`);

	if (fs.existsSync(audioPath) && bot && typeof bot.createMedia === "function") {
		try {
			const media = await bot.createMedia(audioPath, "audio/mp3");
			if (media) {
				retorno.push(
					new ReturnMessage({
						chatId,
						content: media,
						options: {
							quotedMessageId: message.origin?.id?._serialized,
							goReply: message.origin
						}
					})
				);
			}
		} catch (err) {
			logger.error(`Erro ao carregar áudio de hora certa (${audioPath}):`, err);
		}
	}

	return retorno;
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "violencia",
		description: "Pratica um ato de violência",
		category: "zoeira",
		reactions: {
			after: "💢"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "violencia")
	}),
	new Command({
		name: "violência",
		category: "zoeira",
		hidden: "true",
		reactions: {
			after: "💢"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "violencia")
	}),

	new Command({
		name: "morreu",
		description: "de gue?",
		category: "zoeira",
		reactions: {
			after: "💀"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "morreu")
	}),

	new Command({
		name: "boleto",
		description: "Escolhe alguém pra pagar",
		category: "zoeira",
		reactions: {
			after: "🔳"
		},
		method: handleBoletoCommand
	}),
	new Command({
		name: "pagar",
		aliases: ["pagar-boleto"],
		category: "zoeira",
		hidden: true,
		reactions: {
			after: "🤤"
		},
		method: handlePagarBoleto
	}),

	new Command({
		name: "clonarcartao",
		description: "Pra pagar o agiota",
		category: "zoeira",
		reactions: {
			after: "💳"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "cartao")
	}),

	new Command({
		name: "presente",
		description: "Os melhores da internet",
		category: "zoeira",
		reactions: {
			after: "🎁"
		},
		method: presente
	}),

	new Command({
		name: "pix",
		description: "Simula uma transferência fictícia por Pix",
		category: "zoeira",
		reactions: {
			after: "💸"
		},
		method: pix
	}),

	new Command({
		name: "aniversario",
		description: "Parabeniza um membro do grupo!",
		category: "zoeira",
		reactions: {
			after: "🎂"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "aniversario")
	}),
	new Command({
		name: "aniversário",
		category: "zoeira",
		hidden: "true",
		reactions: {
			after: "🎂"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "aniversario")
	}),
	new Command({
		name: "pecar",
		category: "zoeira",
		reactions: {
			after: "⛪️"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "pecados")
	}),
	new Command({
		name: "meus-pecados",
		category: "zoeira",
		hidden: "true",
		reactions: {
			after: "⛪️"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "pecados")
	}),
	new Command({
		name: "genshin",
		hidden: "false",
		category: "zoeira",
		reactions: {
			after: "☄️"
		},
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "genshin")
	}),
	new Command({
		name: "hora",
		aliases: ["data"],
		description: "Informa a data e hora atual com precisão aproximada",
		category: "zoeira",
		reactions: {
			after: "🕒"
		},
		method: horaDataCommand
	}),
	new Command({
		name: "data",
		category: "zoeira",
		hidden: true,
		reactions: {
			after: "🗓"
		},
		method: horaDataCommand
	})
];

const helper = {
	about: "Comandos de humor, zoeira e brincadeiras sociais para animar o grupo",
	implementation:
		"Sorteia membros do grupo e processa variáveis customizadas para piadas, PIX fictício, clonagem de cartão e aniversário",
	tags: "zoeira,humor,brincadeiras,memes,pix,aniversario,boleto,violencia,hora,data",
	cmds: [
		{
			cmd: "!violencia",
			desc: "Pratica um ato cômico de violência contra outro membro",
			usage: ["!violencia @fulano"],
			category: "zoeira"
		},
		{
			cmd: "!morreu",
			desc: "Envia meme de anúncio fúnebre zoeiro",
			usage: ["!morreu @fulano"],
			category: "zoeira"
		},
		{
			cmd: "!boleto",
			desc: "Escolhe um membro do grupo aleatoriamente para pagar um boleto",
			usage: ["!boleto"],
			category: "zoeira"
		},
		{
			cmd: "!clonarcartao",
			desc: "Simula uma clonagem de cartão para pagar o agiota",
			usage: ["!clonarcartao @fulano"],
			category: "zoeira"
		},
		{
			cmd: "!presente",
			desc: "Envia um presente zoeiro da internet para alguém",
			usage: ["!presente @fulano"],
			category: "zoeira"
		},
		{
			cmd: "!pix",
			desc: "Simula uma transferência fictícia por Pix",
			usage: ["!pix 1000 @fulano"],
			category: "zoeira"
		},
		{
			cmd: "!aniversario",
			desc: "Parabeniza um aniversariante do grupo em grande estilo",
			usage: ["!aniversario @fulano"],
			category: "zoeira"
		},
		{
			cmd: "!hora",
			desc: "Informa a hora e a data atual com precisão aproximada",
			usage: ["!hora", "!data"],
			category: "zoeira"
		}
	]
};

module.exports = {
	helper,
	commands,
	recordBoletoMessage
};
