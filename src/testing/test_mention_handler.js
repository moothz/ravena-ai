"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const PhoneUtils = require("../utils/PhoneUtils");
const MentionHandler = require("../MentionHandler");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== Testando PhoneUtils ===");

	// 1. Variantes de número brasileiro 12 dígitos (rav-ric histórico)
	const variants12 = PhoneUtils.getPhoneVariants("552492052933");
	assert(variants12.includes("552492052933"), "Deve conter a versão 12 dígitos");
	assert(variants12.includes("5524992052933"), "Deve gerar a versão 13 dígitos com '9'");

	// 2. Variantes de número brasileiro 13 dígitos (rav-ric real)
	const variants13 = PhoneUtils.getPhoneVariants("5524992052933");
	assert(variants13.includes("5524992052933"), "Deve conter a versão 13 dígitos");
	assert(variants13.includes("552492052933"), "Deve gerar a versão 12 dígitos sem '9'");

	// 3. Caso rav-kingo (13 dígitos com 9 no bots.json vs 12 dígitos no WhatsApp)
	assert(
		PhoneUtils.isSamePhone("5547988130617", "554788130617"),
		"rav-kingo 13 vs 12 deve coincidir"
	);
	assert(
		PhoneUtils.isSamePhone("552492052933", "5524992052933@s.whatsapp.net"),
		"rav-ric 12 vs 13 com JID deve coincidir"
	);

	// 4. matchesParticipant
	const participantRic = {
		JID: "253807434973210@lid",
		PhoneNumber: "5524992052933@s.whatsapp.net",
		LID: "253807434973210@lid"
	};
	assert(
		PhoneUtils.matchesParticipant(participantRic, "552492052933"),
		"matchesParticipant deve encontrar participante mesmo com 8 dígitos no bot"
	);
	assert(
		PhoneUtils.matchesParticipant(participantRic, "5524992052933"),
		"matchesParticipant deve encontrar participante com 9 dígitos"
	);

	console.log("✓ PhoneUtils passou em todos os testes!");

	console.log("\n=== Testando getLidFromPn em WhatsAppBotGo ===");
	const mockChat = {
		Participants: [
			{
				JID: "108662924308586@lid",
				PhoneNumber: "555596424307@s.whatsapp.net",
				LID: "108662924308586@lid"
			},
			participantRic
		]
	};

	const botMock = Object.create(WhatsAppBotGo.prototype);
	botMock.phoneNumber = "552492052933"; // 8 dígitos
	botMock.lidToPnCache = new Map();

	const lidFoundWith8Digits = botMock.getLidFromPn("552492052933", mockChat);
	assert.equal(
		lidFoundWith8Digits,
		"253807434973210@lid",
		"getLidFromPn deve retornar o LID correto mesmo se PN tiver 8 dígitos"
	);

	const lidFoundWith9Digits = botMock.getLidFromPn("5524992052933", mockChat);
	assert.equal(
		lidFoundWith9Digits,
		"253807434973210@lid",
		"getLidFromPn deve retornar o LID correto quando PN tiver 9 dígitos"
	);

	console.log("✓ getLidFromPn passou em todos os testes!");

	console.log("\n=== Testando MentionHandler ===");
	const mentionHandler = new MentionHandler();

	let capturedMessages = [];
	let capturedReactions = [];

	const fakeBot = {
		id: "rav-ric",
		nomeExibir: "Rav-Ric",
		phoneNumber: "552492052933", // mesmo com número histórico de 8 dígitos
		getChatDetails: async () => mockChat,
		getLidFromPn: (pn, chat) => botMock.getLidFromPn(pn, chat),
		sendReturnMessages: async (msgs) => {
			if (Array.isArray(msgs)) capturedMessages.push(...msgs);
			else capturedMessages.push(msgs);
		}
	};

	// 1. Mensagem marcada pelo WhatsApp (@LID boa noite)
	const msgLid = createMessage({
		group: "120363421278491815@g.us",
		author: "5524999999999@s.whatsapp.net",
		content: "@253807434973210 boa noite",
		mentions: ["253807434973210@lid"]
	});
	msgLid.origin.react = async (emoji) => capturedReactions.push(emoji);

	capturedMessages = [];
	capturedReactions = [];
	const handledLid = await mentionHandler.processMention(
		fakeBot,
		msgLid,
		{ id: msgLid.group },
		msgLid.content
	);
	assert.equal(handledLid, true, "Menção via @LID deve ser tratada");
	assert.equal(capturedReactions.length, 1, "Deve aplicar reação");

	// 2. Mensagem marcada por número (@5524992052933 boa noite)
	const msgPhone = createMessage({
		group: "120363421278491815@g.us",
		author: "5524999999999@s.whatsapp.net",
		content: "@5524992052933 boa noite",
		mentions: ["5524992052933@s.whatsapp.net"]
	});
	msgPhone.origin.react = async (emoji) => capturedReactions.push(emoji);

	capturedMessages = [];
	capturedReactions = [];
	const handledPhone = await mentionHandler.processMention(
		fakeBot,
		msgPhone,
		{ id: msgPhone.group },
		msgPhone.content
	);
	assert.equal(handledPhone, true, "Menção via @Phone deve ser tratada");

	// 3. Mensagem digitada com o nome do bot (@rav-ric boa noite)
	const msgName = createMessage({
		group: "120363421278491815@g.us",
		author: "5524999999999@s.whatsapp.net",
		content: "@rav-ric boa noite",
		mentions: []
	});
	msgName.origin.react = async (emoji) => capturedReactions.push(emoji);

	capturedMessages = [];
	capturedReactions = [];
	const handledName = await mentionHandler.processMention(
		fakeBot,
		msgName,
		{ id: msgName.group },
		msgName.content
	);
	assert.equal(handledName, true, "Menção via @rav-ric deve ser tratada");

	// 4. Mensagem com @rav-ric, com vírgula (@rav-ric, como vai?)
	const msgComma = createMessage({
		group: "120363421278491815@g.us",
		author: "5524999999999@s.whatsapp.net",
		content: "@rav-ric, como vai?",
		mentions: []
	});
	msgComma.origin.react = async (emoji) => capturedReactions.push(emoji);

	const handledComma = await mentionHandler.processMention(
		fakeBot,
		msgComma,
		{ id: msgComma.group },
		msgComma.content
	);
	assert.equal(handledComma, true, "Menção com vírgula deve ser tratada");

	// 5. Menção sem texto (@rav-ric) -> deve enviar mensagem de ajuda padrão
	const msgEmpty = createMessage({
		group: "120363421278491815@g.us",
		author: "5524999999999@s.whatsapp.net",
		content: "@rav-ric",
		mentions: []
	});
	msgEmpty.origin.react = async (emoji) => capturedReactions.push(emoji);

	capturedMessages = [];
	const handledEmpty = await mentionHandler.processMention(
		fakeBot,
		msgEmpty,
		{ id: msgEmpty.group },
		msgEmpty.content
	);
	assert.equal(handledEmpty, true, "Menção sem texto deve ser tratada");
	assert.equal(capturedMessages.length, 1, "Deve enviar mensagem de resposta padrão");
	assert(
		capturedMessages[0].content.includes("Como posso te ajudar"),
		"Resposta deve conter texto padrão"
	);

	// 6. Mensagem marcando outra pessoa não relacionada
	const msgOther = createMessage({
		group: "120363421278491815@g.us",
		author: "5524999999999@s.whatsapp.net",
		content: "@5511999999999 bom dia",
		mentions: ["5511999999999@s.whatsapp.net"]
	});

	const handledOther = await mentionHandler.processMention(
		fakeBot,
		msgOther,
		{ id: msgOther.group },
		msgOther.content
	);
	assert.equal(handledOther, false, "Menção a outro usuário NÃO deve ser tratada");

	console.log("✓ MentionHandler passou em todos os testes!");
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
