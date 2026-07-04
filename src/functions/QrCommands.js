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
 * Validates a Brazilian CPF
 */
function isValidCpf(cpf) {
	if (typeof cpf !== "string") return false;

	// Remove non-digits
	const clean = cpf.replace(/\D/g, "");

	// Must be exactly 11 digits
	if (clean.length !== 11) return false;

	// Reject known invalid CPFs (all identical digits)
	if (/^(\d)\1{10}$/.test(clean)) return false;

	const calcularDigito = (s) => {
		const r = s.split("").reduce((a, n, i) => a + parseInt(n) * (s.length + 1 - i), 0) % 11;
		return r < 2 ? 0 : 11 - r;
	};

	const base = clean.slice(0, 9);
	const dig1 = calcularDigito(base);
	const dig2 = calcularDigito(base + dig1);

	return clean === base + dig1 + dig2;
}

/**
 * Validates a Brazilian CNPJ
 */
function isValidCnpj(cnpj) {
	if (typeof cnpj !== "string") return false;

	// Remove non-digits
	const clean = cnpj.replace(/\D/g, "");

	// Must be exactly 14 digits
	if (clean.length !== 14) return false;

	// Reject known invalid CNPJs (all identical digits)
	if (/^(\d)\1{13}$/.test(clean)) return false;

	const calcularDigito = (s, pesos) => {
		const r = s.split("").reduce((a, n, i) => a + parseInt(n) * pesos[i], 0) % 11;
		return r < 2 ? 0 : 11 - r;
	};

	const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
	const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

	const base = clean.slice(0, 12);
	const dig1 = calcularDigito(base, pesos1);
	const dig2 = calcularDigito(base + dig1, pesos2);

	return clean === base + dig1 + dig2;
}

/**
 * Validates and formats Pix Keys: CPF, CNPJ, Celular, E-mail, EVP (Chave Aleatória)
 */
function identifyAndValidatePixKey(rawKey) {
	if (typeof rawKey !== "string") return null;

	const trimmed = rawKey.trim();

	// 1. Check Email
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (emailRegex.test(trimmed)) {
		return {
			type: "email",
			normalized: trimmed,
			formatted: trimmed
		};
	}

	// 2. Check CPF
	const cleanCpf = trimmed.replace(/\D/g, "");
	if (cleanCpf.length === 11 && isValidCpf(cleanCpf)) {
		const formatted = `${cleanCpf.slice(0, 3)}.${cleanCpf.slice(3, 6)}.${cleanCpf.slice(6, 9)}-${cleanCpf.slice(9)}`;
		return {
			type: "cpf",
			normalized: cleanCpf,
			formatted
		};
	}

	// 3. Check CNPJ
	const cleanCnpj = trimmed.replace(/\D/g, "");
	if (cleanCnpj.length === 14 && isValidCnpj(cleanCnpj)) {
		const formatted = `${cleanCnpj.slice(0, 2)}.${cleanCnpj.slice(2, 5)}.${cleanCnpj.slice(5, 8)}/${cleanCnpj.slice(8, 12)}-${cleanCnpj.slice(12)}`;
		return {
			type: "cnpj",
			normalized: cleanCnpj,
			formatted
		};
	}

	// 4. Check Phone (Celular)
	const phoneClean = trimmed.replace(/[^\d+]/g, "");
	const hasPlus = phoneClean.startsWith("+");
	const digitsOnly = phoneClean.replace("+", "");

	let finalPhone = "";
	if (hasPlus) {
		if (digitsOnly.length >= 12 && digitsOnly.length <= 14) {
			finalPhone = `+${digitsOnly}`;
		}
	} else {
		if (digitsOnly.length === 10 || digitsOnly.length === 11) {
			finalPhone = `+55${digitsOnly}`;
		} else if (
			digitsOnly.startsWith("55") &&
			(digitsOnly.length === 12 || digitsOnly.length === 13)
		) {
			finalPhone = `+${digitsOnly}`;
		}
	}

	if (finalPhone) {
		const ddd = finalPhone.slice(3, 5);
		const number = finalPhone.slice(5);
		let formattedNumber = number;
		if (number.length === 9) {
			formattedNumber = `${number.slice(0, 5)}-${number.slice(5)}`;
		} else if (number.length === 8) {
			formattedNumber = `${number.slice(0, 4)}-${number.slice(4)}`;
		}
		const formatted = `(${ddd}) ${formattedNumber}`;
		return {
			type: "phone",
			normalized: finalPhone,
			formatted
		};
	}

	// 5. Check EVP (Random Key - UUID)
	const uuidPatternWithDashes =
		/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
	const uuidPatternNoDashes = /^[0-9a-fA-F]{32}$/;

	if (uuidPatternWithDashes.test(trimmed)) {
		const normalized = trimmed.toLowerCase();
		return {
			type: "evp",
			normalized,
			formatted: normalized
		};
	} else if (uuidPatternNoDashes.test(trimmed)) {
		const normalized = trimmed.toLowerCase();
		const formatted = `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
		return {
			type: "evp",
			normalized: formatted,
			formatted
		};
	}

	return null;
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

	const keyInfo = identifyAndValidatePixKey(args[0]);
	if (!keyInfo) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Chave PIX inválida.\n\nA chave informada deve ser de um dos seguintes tipos:\n" +
				"• *CPF*: 11 dígitos (ex: 000.836.590-30)\n" +
				"• *CNPJ*: 14 dígitos (ex: 00.000.000/0001-00)\n" +
				"• *Celular*: DDD + número (ex: 11999999999)\n" +
				"• *E-mail*: endereço válido (ex: nome@email.com)\n" +
				"• *Chave Aleatória*: Formato UUID (ex: 123e4567-e89b-12d3-a456-426614174000)",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	const pixKey = keyInfo.normalized;
	const label =
		keyInfo.type === "cpf"
			? "Chave CPF"
			: keyInfo.type === "cnpj"
				? "Chave CNPJ"
				: keyInfo.type === "phone"
					? "Chave Celular"
					: keyInfo.type === "email"
						? "Chave E-mail"
						: "Chave Aleatória";

	let description = "";
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
		const userName =
			message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Pessoa";
		let merchantName = userName
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-zA-Z0-9\s]/g, "")
			.replace(/\s+/g, " ")
			.trim();

		if (merchantName.length < 3) {
			merchantName = "Pessoa";
		} else {
			merchantName = merchantName.substring(0, 25);
		}

		const payload = generatePixPayload(pixKey, description, value, merchantName);
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

		const keyText = `${label}: ${keyInfo.formatted}`;
		let keyFontSize = "16px";
		if (keyText.length > 40) {
			keyFontSize = "13px";
		} else if (keyText.length > 30) {
			keyFontSize = "14px";
		}

		if (value) {
			ctx.fillText(`PIX: R$ ${value}`, canvas.width / 2, currentY);
			currentY += 25;
			ctx.font = `${keyFontSize} Arial`;
			ctx.fillText(keyText, canvas.width / 2, currentY);
			currentY += 25;
		} else {
			ctx.font = `bold ${keyFontSize === "16px" ? "20px" : keyFontSize} Arial`;
			ctx.fillText(keyText, canvas.width / 2, currentY);
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
				caption: `💠 *PIX Gerado*\n\n*${label}:* \`${keyInfo.formatted}\`${description ? `\n*Descrição:* ${description}` : ""}${value ? `\n*Valor:* R$ ${value}` : ""}\n\n*Payload (Copia e Cola):*\n\`${payload}\``,
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
function generatePixPayload(key, description, value, merchantName) {
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
	payload += f("59", merchantName || "Pessoa"); // Merchant Name
	payload += f("60", "Sao Paulo"); // Merchant City

	// 62: Additional Data Field Template
	const cleanDesc = (description || "").substring(0, 25).replace(/\s/g, "");
	const txid = f("05", cleanDesc || "***");
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
