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

const gerarDataHoraAtual = () => {
	const agora = new Date();
	const dia = String(agora.getDate()).padStart(2, "0");
	const mes = String(agora.getMonth() + 1).padStart(2, "0"); // Meses são 0-indexados
	const ano = agora.getFullYear();
	const horas = String(agora.getHours()).padStart(2, "0");
	const minutos = String(agora.getMinutes()).padStart(2, "0");
	return `${dia}/${mes}/${ano} às ${horas}:${minutos}`;
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
	ctx.fillText(`ravena.moothz.win`, largura / 2, y);

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
		method: async (bot, message, args, group) =>
			await handleComandoVariavelSimples(bot, message, args, group, "boleto")
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
		description: "Faz uma transferência pela Ravenabank",
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
	})
];

module.exports = { commands };
