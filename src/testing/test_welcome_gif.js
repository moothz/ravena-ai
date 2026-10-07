process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const WhatsAppBotGo = require("../WhatsAppBotGo");

async function main() {
	console.log("--- Testing Welcome GIF Handling & WhatsAppBotGo payload.type ---");

	// 1. Setup a dummy gif in databasePath/media if needed
	const database = require("../utils/Database").getInstance({ testMode: true });
	const mediaDir = path.join(database.databasePath, "media");
	if (!fs.existsSync(mediaDir)) {
		fs.mkdirSync(mediaDir, { recursive: true });
	}

	const testGifPath = path.join(mediaDir, "test_dummy.gif");
	fs.writeFileSync(
		testGifPath,
		Buffer.from(
			"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
		)
	);

	const fakeBot = new FakeBot({ id: "test-bot" });
	const handler = new EventHandler();

	// Test 1: generateGreetingMessage with group.greetings.gif
	{
		const group = {
			id: "123456@g.us",
			name: "Grupo Teste",
			greetings: {
				text: "Olá {pessoa}!",
				gif: {
					file: "test_dummy.gif",
					caption: "Legenda do gif"
				}
			}
		};

		const user = { id: "5511999999999@s.whatsapp.net" };
		const chat = { name: "Grupo Teste" };

		const msgs = await handler.generateGreetingMessage(fakeBot, group, user, chat);
		assert.strictEqual(msgs.length, 2, "Deveria gerar 2 mensagens (texto e gif)");
		assert.strictEqual(msgs[0].message, "Olá @5511999999999!", "Primeira mensagem deve ser texto");
		assert.strictEqual(
			msgs[1].options.sendVideoAsGif,
			true,
			"Segunda mensagem deve ter sendVideoAsGif = true"
		);
		console.log("✓ Test 1 passed: group.greetings.gif ativa sendVideoAsGif = true");
	}

	// Test 2: generateGreetingMessage with group.greetings.image containing a .gif file (fallback)
	{
		const group = {
			id: "123456@g.us",
			name: "Grupo Teste",
			greetings: {
				image: {
					file: "test_dummy.gif",
					caption: "GIF salvo sob a chave image"
				}
			}
		};

		const user = { id: "5511999999999@s.whatsapp.net" };
		const chat = { name: "Grupo Teste" };

		const msgs = await handler.generateGreetingMessage(fakeBot, group, user, chat);
		assert.strictEqual(msgs.length, 1, "Deveria gerar 1 mensagem");
		assert.strictEqual(
			msgs[0].options.sendVideoAsGif,
			true,
			"Mídia GIF salva sob chave 'image' deve ter sendVideoAsGif = true"
		);
		console.log("✓ Test 2 passed: GIF sob chave 'image' detectado e sendVideoAsGif = true");
	}

	// Test 3: WhatsAppBotGo.sendMessage payload.type for GIF MessageMedia
	{
		const botGo = new WhatsAppBotGo({
			id: "test-go",
			nome: "test-go",
			goInstanceName: "test-go",
			phoneNumber: "551199999999",
			whatsgoApiUrl: "http://localhost:8080",
			whatsgoApiKey: "test-key",
			webhookHost: "http://localhost:5001",
			webhookPort: 9999
		});

		botGo.isConnected = true;
		botGo.createMediaFromBase64 = async (data, mimeType, filename) => ({
			url: `http://example.com/${filename || "media"}`
		});

		let capturedPayload = null;
		let capturedEndpoint = null;

		botGo.apiClient = {
			post: async (endpoint, payload) => {
				capturedEndpoint = endpoint;
				capturedPayload = payload;
				return { data: { success: true } };
			}
		};

		// 3a. MessageMedia with mimetype 'image/gif' and options.sendVideoAsGif = true
		capturedPayload = null;
		await botGo.sendMessage(
			"123456@g.us",
			{
				mimetype: "image/gif",
				data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
				filename: "yone.gif",
				isMessageMedia: true
			},
			{ sendVideoAsGif: true }
		);

		assert.strictEqual(capturedEndpoint, "/send/media");
		assert.strictEqual(
			capturedPayload.type,
			"gif",
			`Esperava payload.type = 'gif' para imagem GIF com sendVideoAsGif, recebeu '${capturedPayload.type}'`
		);
		console.log("✓ Test 3a passed: WhatsAppBotGo define payload.type = 'gif' com sendVideoAsGif");

		// 3b. MessageMedia with mimetype 'image/gif' without options.sendVideoAsGif
		capturedPayload = null;
		await botGo.sendMessage(
			"123456@g.us",
			{
				mimetype: "image/gif",
				data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
				filename: "animacao.gif",
				isMessageMedia: true
			},
			{}
		);

		assert.strictEqual(capturedEndpoint, "/send/media");
		assert.strictEqual(
			capturedPayload.type,
			"gif",
			`Esperava payload.type = 'gif' para arquivo image/gif sem sendVideoAsGif, recebeu '${capturedPayload.type}'`
		);
		console.log(
			"✓ Test 3b passed: WhatsAppBotGo define payload.type = 'gif' automaticamente para image/gif"
		);

		// 3c. URL string ending in .gif
		capturedPayload = null;
		await botGo.sendMessage("123456@g.us", "http://example.com/attachments/test.gif", {});
		assert.strictEqual(capturedEndpoint, "/send/media");
		assert.strictEqual(
			capturedPayload.type,
			"gif",
			`Esperava payload.type = 'gif' para URL .gif, recebeu '${capturedPayload.type}'`
		);
		console.log(
			"✓ Test 3c passed: WhatsAppBotGo define payload.type = 'gif' para URL terminada em .gif"
		);

		// 3d. Normal JPEG image should remain 'image'
		capturedPayload = null;
		await botGo.sendMessage(
			"123456@g.us",
			{
				mimetype: "image/jpeg",
				data: "dGVzdA==",
				filename: "foto.jpg",
				isMessageMedia: true
			},
			{}
		);
		assert.strictEqual(capturedEndpoint, "/send/media");
		assert.strictEqual(
			capturedPayload.type,
			"image",
			`Esperava payload.type = 'image' para JPEG, recebeu '${capturedPayload.type}'`
		);
		console.log("✓ Test 3d passed: WhatsAppBotGo mantém payload.type = 'image' para JPEG comum");
	}

	// Clean up dummy gif
	try {
		if (fs.existsSync(testGifPath)) fs.unlinkSync(testGifPath);
	} catch (e) {}

	console.log("\nTodos os testes de GIF e boas-vindas passaram com sucesso!");
	process.exit(0);
}

main().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
