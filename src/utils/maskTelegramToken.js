const BOT_ID = /\d{6}(?::|%(?:25)?3A)/.source;
const HEX_OR_UUID = /[\da-f-]+(?![\w-])/.source;
const SECRET = /[\w-]{30,}/.source;
const TELEGRAM_TOKEN = new RegExp(`(${BOT_ID})(?!${HEX_OR_UUID})${SECRET}`, "gi");

function maskTelegramToken(text) {
	return text.replace(TELEGRAM_TOKEN, "$1***");
}

module.exports = maskTelegramToken;
