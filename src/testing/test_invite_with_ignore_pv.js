process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const InviteSystem = require("../InviteSystem");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");

async function runTests() {
	console.log("=== INICIANDO TESTES: CONVITES COM ignorePV: true ===");

	const database = Database.getInstance({ testMode: true });
	database.testMode = true;

	const eventHandler = new EventHandler();

	const botWithIgnorePv = new FakeBot({
		id: "bot-ignore-pv",
		phoneNumber: "5511999990001",
		grupoLogs: "120363000000000001@g.us",
		grupoInvites: "120363000000000002@g.us"
	});
	botWithIgnorePv.ignorePV = true;
	botWithIgnorePv.ignoreInvites = false;
	botWithIgnorePv.notInWhitelist = () => true;
	botWithIgnorePv.inviteSystem = new InviteSystem(botWithIgnorePv);

	const groupCode = "INVITETEST12345";
	let reactedEmoji = null;
	botWithIgnorePv.client.getInviteInfo = async (code) => {
		if (code === groupCode) {
			return {
				IsCommunity: false,
				ParticipantCount: 25,
				JID: "120363000000000099@g.us",
				Name: "Grupo de Teste",
				Participants: [
					{ PhoneNumber: "5511999990001@s.whatsapp.net" } // Simula bot já presente para resposta determinística e rápida
				]
			};
		}
		return null;
	};

	// 1. Mensagem com link de convite em PV: deve ser interceptada e processada mesmo com ignorePV=true
	console.log("\n1. Testando link de convite no PV com ignorePV: true e ignoreInvites: false...");
	const inviteMsg = createMessage({
		content: `Entrem no meu grupo: https://chat.whatsapp.com/${groupCode}`,
		author: "5511999991111@s.whatsapp.net",
		group: null,
		type: "text"
	});
	inviteMsg.origin.react = async (emoji) => {
		reactedEmoji = emoji;
	};

	botWithIgnorePv.resetCapture();
	await eventHandler.processMessage(botWithIgnorePv, inviteMsg);

	assert.strictEqual(reactedEmoji, "🤖", "Deve reagir com emoji 🤖 ao detectar bot no grupo");
	assert.ok(
		botWithIgnorePv.capturedMessages.length > 0,
		"Deve enviar mensagem de resposta ao convite"
	);

	// 2. Mensagem comum ou comando normal no PV com ignorePV: true: deve ser ignorada
	console.log("\n2. Testando comando comum no PV com ignorePV: true...");
	botWithIgnorePv.resetCapture();
	const cmdMsg = createMessage({
		content: "!ping",
		author: "5511999991111@s.whatsapp.net",
		group: null,
		type: "text"
	});
	await eventHandler.processMessage(botWithIgnorePv, cmdMsg);
	// Espera um pouco para garantir que nenhum comando foi enfileirado
	await new Promise((r) => setTimeout(r, 200));
	assert.strictEqual(
		botWithIgnorePv.capturedMessages.length,
		0,
		"Comando comum no PV deve ser ignorado quando ignorePV=true"
	);

	// 3. Bot com ignorePV: true e ignoreInvites: true: convite NÃO deve ser processado
	console.log("\n3. Testando link de convite no PV com ignorePV: true e ignoreInvites: true...");
	const botIgnoreAll = new FakeBot({
		id: "bot-ignore-all",
		phoneNumber: "5511999990002"
	});
	botIgnoreAll.ignorePV = true;
	botIgnoreAll.ignoreInvites = true;
	botIgnoreAll.notInWhitelist = () => true;
	botIgnoreAll.inviteSystem = new InviteSystem(botIgnoreAll);

	let reactedEmojiIgnore = null;
	const inviteMsgIgnore = createMessage({
		content: `https://chat.whatsapp.com/${groupCode}`,
		author: "5511999991111@s.whatsapp.net",
		group: null,
		type: "text"
	});
	inviteMsgIgnore.origin.react = async (emoji) => {
		reactedEmojiIgnore = emoji;
	};

	botIgnoreAll.resetCapture();
	await eventHandler.processMessage(botIgnoreAll, inviteMsgIgnore);
	await new Promise((r) => setTimeout(r, 200));

	assert.strictEqual(reactedEmojiIgnore, null, "Não deve reagir a convites se ignoreInvites=true");
	assert.strictEqual(
		botIgnoreAll.capturedMessages.length,
		0,
		"Não deve responder a convites se ignoreInvites=true e ignorePV=true"
	);

	// Cleanup
	botWithIgnorePv.inviteSystem.destroy();
	botIgnoreAll.inviteSystem.destroy();

	console.log("\n✅ Todos os testes de convite com ignorePV passaram com sucesso!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
