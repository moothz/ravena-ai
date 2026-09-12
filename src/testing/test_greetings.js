const assert = require("assert");
const EventHandler = require("../EventHandler");

async function runTests() {
	console.log("--- Starting greetings tests ---");

	const eventHandler = new EventHandler();

	const fakeBot = {
		id: "ravena-teste",
		sendMessage: async (chatId, msg, options) => {
			fakeBot.sent.push({ chatId, msg, options });
		},
		sent: []
	};

	// 1. Test group with text only (like gp_zuera)
	const groupTextOnly = {
		id: "gp_zuera@g.us",
		name: "gpzuera",
		greetings: {
			text: "Olá {pessoa}, bem vindo ao gpzuera!"
		}
	};

	const msgs1 = await eventHandler.generateGreetingMessage(
		fakeBot,
		groupTextOnly,
		{ id: "5511999999999@s.whatsapp.net" },
		{ name: "GP Zuera" }
	);

	assert.strictEqual(msgs1.length, 1, "Should generate 1 message for text-only group");
	assert.strictEqual(typeof msgs1[0].message, "string");
	assert(msgs1[0].message.includes("@5511999999999"));
	console.log("✓ Text-only group greeting test passed");

	// 2. Test group with text, video and image (like gt3rs)
	const groupGt3rs = {
		id: "gt3rs@g.us",
		name: "gt3rs",
		greetings: {
			video: {
				file: "nonexistent-video.mp4",
				caption: "Tutorial de pintura"
			},
			image: {
				file: "nonexistent-image.jpeg",
				caption: "BEM VINDO"
			},
			text: "teclado mecanico 60% é horrivel\n"
		}
	};

	const msgs2 = await eventHandler.generateGreetingMessage(
		fakeBot,
		groupGt3rs,
		{ id: "5511999999999@s.whatsapp.net" },
		{ name: "TEAM GT3RS OFC" }
	);

	// Since files are nonexistent on fake paths, media loading will error and only text will be generated,
	// BUT the text message MUST be present and not skipped!
	assert(msgs2.length >= 1, "Text message must NOT be skipped when media is configured");
	assert.strictEqual(
		msgs2[0].message,
		"teclado mecanico 60% é horrivel\n",
		"Text message must be the configured text"
	);
	console.log("✓ gt3rs text message preservation test passed");

	// 3. Test priority order (text must be first)
	const groupWithOrder = {
		id: "order@g.us",
		name: "order",
		greetings: {
			audio: {
				file: "nonexistent.ogg"
			},
			sticker: {
				file: "nonexistent.webp"
			},
			text: "Boas vindas!"
		}
	};

	const msgs3 = await eventHandler.generateGreetingMessage(
		fakeBot,
		groupWithOrder,
		{ id: "5511888888888@s.whatsapp.net" },
		{ name: "Order Test" }
	);

	assert.strictEqual(msgs3.length, 1, "Text message must be generated even if audio/sticker exist");
	assert.strictEqual(msgs3[0].message, "Boas vindas!");
	console.log("✓ Text with sticker/audio test passed");

	// 4. Test farewells ordering
	const groupFarewells = {
		id: "fw@g.us",
		name: "farewell",
		farewells: {
			sticker: {
				file: "nonexistent.webp"
			},
			text: "Adeus {pessoa}!"
		}
	};

	const fwMsgs = await eventHandler.processFarewellMessage(
		groupFarewells,
		{ id: "5511777777777@s.whatsapp.net" },
		fakeBot,
		{ name: "Farewell Test" }
	);

	assert.strictEqual(fwMsgs.length, 1);
	assert(fwMsgs[0].message.includes("@5511777777777"));
	console.log("✓ Farewells test passed");

	console.log("--- All greeting tests passed! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
