"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const StickerScraper = require("../functions/StickerScraper");

async function main() {
	const stickerId = 700000 + process.pid;
	const chatId = "120363000000000000@g.us";
	const logChatId = "120363999999999999@g.us";
	const stickerPath = StickerScraper.getStickerFilePath(stickerId);
	const fs = require("fs");
	fs.writeFileSync(stickerPath, Buffer.alloc(4000, 1));

	const deleted = [];
	const bot = {
		id: "auto-report-test-bot",
		grupoLogs: logChatId,
		deleteMessageByKey: async (key) => deleted.push(key)
	};

	const makeMessage = (index) => {
		const quotedId = `auto-report-sticker-${index}`;
		StickerScraper.recordSentStickerMessage(quotedId, stickerId, chatId, bot.id);
		return {
			id: `report-${index}`,
			group: chatId,
			author: `user-${index}@s.whatsapp.net`,
			authorName: `User ${index}`,
			quotedMessageId: quotedId,
			hasQuotedMsg: true,
			origin: {
				getQuotedMessage: async () => ({
					id: quotedId,
					type: "sticker",
					downloadMedia: async () => ({
						data: Buffer.alloc(4000, 1).toString("base64")
					})
				})
			}
		};
	};

	const first = await StickerScraper.figaDenunciarCommand(bot, makeMessage(1), [], {
		name: "Grupo Teste"
	});
	const second = await StickerScraper.figaDenunciarCommand(bot, makeMessage(2), [], {
		name: "Grupo Teste"
	});
	const thirdMessage = makeMessage(3);
	const third = await StickerScraper.figaDenunciarCommand(bot, thirdMessage, [], {
		name: "Grupo Teste"
	});

	assert.equal(first.length, 4, "A primeira denúncia deve notificar o grupo de logs");
	assert.equal(second.length, 1, "A segunda denúncia não deve repetir a notificação");
	assert.match(third.content, /removida automaticamente após 3 denúncias/);
	assert.equal(deleted.length, 3, "O terceiro reporte deve apagar as ocorrências rastreadas");
	assert.equal(StickerScraper.isBlacklisted(stickerId), true);

	console.log(
		"StickerScraper: denúncias deduplicadas e remoção automática no terceiro reporte passaram."
	);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
