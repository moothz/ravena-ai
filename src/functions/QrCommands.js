const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const qr = require("qr-image");
const { createCanvas, loadImage } = require("canvas");

const logger = new Logger("qr-commands");

/**
 * Generates a basic QR Code
 */
async function qrCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	let text = args.join(" ");

	// Support replying to a message
	const quotedMsg = await message.origin.getQuotedMessage();
	if (quotedMsg) {
		const quotedText = quotedMsg.caption ?? quotedMsg.body ?? quotedMsg.content;
		if (quotedText && typeof quotedText === "string") {
			text = text ? `${text} ${quotedText}` : quotedText;
		}
	}

	if (!text || text.trim().length === 0) {
		return new ReturnMessage({
			chatId,
			content: "❌ Por favor, forneça o texto para o QR Code ou responda a uma mensagem.",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	try {
		// Smart cleanup: remove extra spaces and control characters if it looks like a URL
		if (text.startsWith("http")) {
			text = text.trim().replace(/\s+/g, "");
		}

		const qrPng = qr.imageSync(text, { type: "png", margin: 2, size: 10, ec_level: "M" });
		const media = {
			mimetype: "image/png",
			data: qrPng.toString("base64"),
			filename: "qrcode.png",
			isMessageMedia: true
		};

		return new ReturnMessage({
			chatId,
			content: media,
			options: {
				caption: `✅ QR Code gerado para: _${text.substring(0, 100)}${text.length > 100 ? "..." : ""}_`,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Error generating QR Code:", error);
		return "❌ Erro ao gerar QR Code.";
	}
}

/**
 * Generates a WiFi QR Code
 * Format: WIFI:S:<SSID>;T:<WEP|WPA|blank>;P:<PASSWORD>;H:<true|false|blank>;;
 */
async function qrWifiCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Try to get args from body if newline separated
	const content = args.join(" ");
	const lines = content
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	let ssid,
		pass,
		hidden = "false";

	if (lines.length >= 2) {
		ssid = lines[0];
		pass = lines[1];
		if (lines.length >= 3)
			hidden = lines[2].toLowerCase() === "true" || lines[2] === "1" ? "true" : "false";
	} else if (args.length >= 2) {
		ssid = args[0];
		pass = args[1];
		if (args.length >= 3)
			hidden = args[2].toLowerCase() === "true" || args[2] === "1" ? "true" : "false";
	} else {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Uso correto: !qr-wifi [SSID]\n[Senha]\n[Oculta(opcional)]\n\nOu: !qr-wifi SSID Senha",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	try {
		const wifiString = `WIFI:S:${ssid};T:WPA;P:${pass};H:${hidden};;`;
		const qrPng = qr.imageSync(wifiString, { type: "png", margin: 4, size: 10, ec_level: "M" });
		const media = {
			mimetype: "image/png",
			data: qrPng.toString("base64"),
			filename: "wifi-qr.png",
			isMessageMedia: true
		};

		return new ReturnMessage({
			chatId,
			content: media,
			options: {
				caption: `📶 *WiFi QR Code*\n\n*SSID:* ${ssid}\n*Senha:* ${pass}\n*Oculta:* ${hidden === "true" ? "Sim" : "Não"}`,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Error generating WiFi QR Code:", error);
		return "❌ Erro ao gerar QR Code de WiFi.";
	}
}

/**
 * Generates a PIX QR Code
 */
async function qrPixCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Uso correto: !qr-pix [Chave] [Descrição] [Valor]\n\nApenas a chave é obrigatória.",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	let pixKey = args[0];

	// Normalize phone number (celular) if it looks like one
	if (/^\d{10,11}$/.test(pixKey)) {
		// 10 or 11 digits: add +55
		pixKey = `+55${pixKey}`;
	} else if (/^55\d{10,11}$/.test(pixKey)) {
		// 12 or 13 digits starting with 55: add +
		pixKey = `+${pixKey}`;
	}

	let description = "Pagamento via RavenaBot";
	let value = "";

	if (args.length > 1) {
		const remaining = args.slice(1).join(" ");
		const words = remaining.split(/\s+/);
		const lastWord = words[words.length - 1];

		// Check if last word is a valid price (e.g. 10, 10.5, 10,50)
		const priceRegex = /^\d+([.,]\d{1,2})?$/;
		if (priceRegex.test(lastWord) && words.length > 1) {
			value = lastWord.replace(",", ".");
			description = words.slice(0, -1).join(" ");
		} else if (priceRegex.test(lastWord) && words.length === 1) {
			// Only one word after key, and it's a number
			value = lastWord.replace(",", ".");
		} else {
			description = remaining;
		}
	}

	// Final value formatting
	if (value) {
		const numValue = parseFloat(value);
		if (!isNaN(numValue)) {
			value = numValue.toFixed(2);
		} else {
			value = "";
		}
	}

	try {
		const payload = generatePixPayload(pixKey, description, value);
		const qrPngBuffer = qr.imageSync(payload, { type: "png", margin: 2, size: 10, ec_level: "M" });

		// Draw description below image
		const canvas = createCanvas(450, 520);
		const ctx = canvas.getContext("2d");

		// White background
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		// Load QR Image
		const img = await loadImage(qrPngBuffer);
		ctx.drawImage(img, 25, 10, 400, 400);

		// Draw Text
		ctx.fillStyle = "black";
		ctx.font = "bold 20px Arial";
		ctx.textAlign = "center";

		let currentY = 440;

		if (value) {
			ctx.fillText(`PIX: R$ ${value}`, canvas.width / 2, currentY);
			currentY += 25;
			ctx.font = "16px Arial";
			ctx.fillText(`Chave: ${pixKey}`, canvas.width / 2, currentY);
			currentY += 25;
		} else {
			ctx.fillText(`Chave: ${pixKey}`, canvas.width / 2, currentY);
			currentY += 30;
		}

		ctx.font = "16px Arial";
		ctx.fillStyle = "#555";

		// Wrap description
		const wrapText = (text, maxWidth) => {
			const words = text.split(" ");
			const lines = [];
			let currentLine = words[0];
			for (let i = 1; i < words.length; i++) {
				if (ctx.measureText(currentLine + " " + words[i]).width < maxWidth) {
					currentLine += " " + words[i];
				} else {
					lines.push(currentLine);
					currentLine = words[i];
				}
			}
			lines.push(currentLine);
			return lines;
		};

		const descLines = wrapText(description, 400);
		descLines.slice(0, 2).forEach((line, i) => {
			ctx.fillText(line, canvas.width / 2, currentY + i * 20);
		});

		const finalBuffer = canvas.toBuffer("image/png");
		const media = {
			mimetype: "image/png",
			data: finalBuffer.toString("base64"),
			filename: "pix-qr.png",
			isMessageMedia: true
		};

		return new ReturnMessage({
			chatId,
			content: media,
			options: {
				caption: `💠 *PIX Gerado*\n\n*Chave:* \`${pixKey}\`\n*Descrição:* ${description}${value ? `\n*Valor:* R$ ${value}` : ""}\n\n*Payload (Copia e Cola):*\n\`${payload}\``,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Error generating PIX QR Code:", error);
		return "❌ Erro ao gerar PIX. Verifique se a chave é válida.";
	}
}

/**
 * PIX Payload Generator (BRCode Static)
 */
function generatePixPayload(key, description, value) {
	const f = (id, val) => {
		const len = String(val).length.toString().padStart(2, "0");
		return `${id}${len}${val}`;
	};

	// 26: Merchant Account Information
	const gui = f("00", "br.gov.bcb.pix");
	const keyVal = f("01", key);
	const merchantAccount = f("26", gui + keyVal);

	let payload = "";
	payload += f("00", "01"); // Payload Format Indicator
	payload += merchantAccount;
	payload += f("52", "0000"); // Merchant Category Code
	payload += f("53", "986"); // Currency (BRL)

	if (value && parseFloat(value) > 0) {
		payload += f("54", value);
	}

	payload += f("58", "BR"); // Country Code
	payload += f("59", "RavenaBot User"); // Merchant Name
	payload += f("60", "Sao Paulo"); // Merchant City

	// 62: Additional Data Field Template
	const txid = f("05", description.substring(0, 25).replace(/\s/g, ""));
	payload += f("62", txid);

	payload += "6304"; // CRC16 Header

	// CRC16 Calculation (CCITT-FALSE / 0xFFFF)
	let crc = 0xffff;
	for (let i = 0; i < payload.length; i++) {
		crc ^= payload.charCodeAt(i) << 8;
		for (let j = 0; j < 8; j++) {
			if ((crc & 0x8000) !== 0) {
				crc = (crc << 1) ^ 0x1021;
			} else {
				crc <<= 1;
			}
		}
	}
	crc = (crc & 0xffff).toString(16).toUpperCase().padStart(4, "0");

	return payload + crc;
}

const commands = [
	new Command({
		name: "qr",
		description: "Gera um QR Code para um texto ou link",
		category: "utilidades",
		reactions: {
			before: "⌛️",
			after: "✅"
		},
		method: qrCommand
	}),
	new Command({
		name: "qr-wifi",
		description: "Gera um QR Code para conexão WiFi",
		category: "utilidades",
		reactions: {
			before: "⌛️",
			after: "📶"
		},
		method: qrWifiCommand
	}),
	new Command({
		name: "qr-pix",
		description: "Gera um QR Code para pagamento PIX",
		category: "utilidades",
		reactions: {
			before: "⌛️",
			after: "💠"
		},
		method: qrPixCommand
	})
];

module.exports = { commands };
