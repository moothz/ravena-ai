process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const {
	getWhatsAppBroadcastBot,
	broadcastToWhatsAppNoticeChannels
} = require("../utils/BroadcastHelper");
const ProfilePictureHelper = require("../utils/ProfilePictureHelper");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");
const WaifuCommands = require("../functions/WaifuCommands");
const TelegramClient = require("../services/TelegramClient");
const TelegramBot = require("../TelegramBot");
const DiscordBot = require("../DiscordBot");

async function runTests() {
	console.log("=== INICIANDO SUÍTE DE TESTES: AVISOS WHATSAPP & FOTO DE PERFIL ===");

	// ─── 1. TESTE: SELEÇÃO DO BOT WHATSAPP DE BROADCAST ───────────────────────────
	console.log("\n[1] Testando seleção de bot WhatsApp em getWhatsAppBroadcastBot...");
	{
		const botTg = new FakeBot({ id: "tg_bot" });
		botTg.useTelegram = true;

		const botDc = new FakeBot({ id: "dc_bot" });
		botDc.useDiscord = true;

		const botWaNormal = new FakeBot({ id: "ravena_normal" });
		botWaNormal.isConnected = true;

		const botWaDonate = new FakeBot({ id: "ravenavip" });
		botWaDonate.isConnected = true;
		botWaDonate.notificarDonate = true;

		// Deve escolher botWaDonate (notificarDonate / ravenavip)
		const chosen = getWhatsAppBroadcastBot([botTg, botDc, botWaNormal, botWaDonate]);
		assert.strictEqual(
			chosen.id,
			"ravenavip",
			"Deve selecionar o bot WhatsApp prioritário para avisos (notificarDonate / ravenavip)"
		);

		// NUNCA deve escolher Telegram ou Discord
		const onlyTgDc = getWhatsAppBroadcastBot([botTg, botDc]);
		assert.strictEqual(onlyTgDc, null, "Não deve selecionar bot se só houver Telegram/Discord");
		console.log("✓ Seleção de bot WhatsApp prioritário validada com sucesso.");
	}

	// ─── 2. TESTE: BROADCAST PARA CANAIS DE AVISOS DO WHATSAPP ───────────────────
	console.log("\n[2] Testando broadcastToWhatsAppNoticeChannels...");
	{
		const waBot = new FakeBot({
			id: "ravenavip",
			grupoAvisos: "avisos@g.us",
			grupoAnuncios: "anuncios@g.us"
		});
		waBot.isConnected = true;
		waBot.notificarDonate = true;

		let pinnedDuration = null;
		waBot.sendReturnMessages = async (retMsg) => {
			waBot.capturedMessages.push(retMsg);
			return [
				{
					id: "msg_123",
					pin: async (duration) => {
						pinnedDuration = duration;
					}
				}
			];
		};

		const success = await broadcastToWhatsAppNoticeChannels({
			content: {
				mimetype: "image/jpeg",
				data: "fake-jpg-data",
				filename: "peixe.jpg",
				isMessageMedia: true
			},
			options: { caption: "🏆 Pesca Lendária!" },
			pinDuration: 260000,
			botList: [waBot]
		});

		assert.strictEqual(success, true, "Broadcast deve retornar sucesso");
		assert.strictEqual(
			waBot.capturedMessages.length,
			2,
			"Deve enviar para grupoAvisos e grupoAnuncios do WhatsApp"
		);
		const targetChats = waBot.capturedMessages.map((m) => m.chatId);
		assert.ok(targetChats.includes("avisos@g.us"), "Deve incluir avisos@g.us");
		assert.ok(targetChats.includes("anuncios@g.us"), "Deve incluir anuncios@g.us");
		assert.strictEqual(pinnedDuration, 260000, "Deve fixar a mensagem com a duração correta");
		console.log("✓ Broadcast para canais de avisos do WhatsApp validado.");
	}

	// ─── 3. TESTE: NOTIFICAÇÃO DE CASAMENTO LENDÁRIO VIA TELEGRAM ────────────────
	console.log("\n[3] Testando WaifuCommands.notifySpecialMarriage via Telegram...");
	{
		const tgBot = new FakeBot({
			id: "tg_ravena",
			grupoAvisos: "-100123456789"
		});
		tgBot.useTelegram = true;

		const waBot = new FakeBot({
			id: "ravenavip",
			grupoAvisos: "wa_avisos@g.us"
		});
		waBot.isConnected = true;
		waBot.notificarDonate = true;

		// Injeta no Database global para testes
		const Database = require("../utils/Database");
		const db = Database.getInstance();
		const oldBots = db.botInstances;
		db.botInstances = [tgBot, waBot];

		try {
			const character = {
				id: 9999,
				name: "Makima Suprema",
				rarity: "LEGENDARY",
				series: "Chainsaw Man"
			};

			const sent = await WaifuCommands.notifySpecialMarriage(
				tgBot,
				character,
				"UsuarioTelegram",
				"02/11/2026",
				null,
				{ data: "marriage_img_base64" }
			);

			assert.strictEqual(sent, true, "Notificação de casamento deve ser enviada");

			// Verifica se o bot do Telegram enviou para o canal do Telegram
			assert.ok(
				tgBot.capturedMessages.some((m) => m.chatId === "-100123456789"),
				"TelegramBot deve enviar para o canal do Telegram"
			);

			// Verifica se o bot do WhatsApp recebeu o broadcast do casamento ocorrido no Telegram
			assert.ok(
				waBot.capturedMessages.some((m) => m.chatId === "wa_avisos@g.us"),
				"WhatsAppBot deve receber o broadcast do casamento lendário ocorrido no Telegram"
			);
			console.log("✓ Casamento lendário originado no Telegram sincronizado para o WhatsApp!");
		} finally {
			db.botInstances = oldBots;
		}
	}

	// ─── 4. TESTE: TELEGRAMCLIENT E TELEGRAMBOT GETPROFILEPICTUREURL ─────────────
	console.log("\n[4] Testando getProfilePictureUrl no TelegramClient e TelegramBot...");
	{
		const tgClient = new TelegramClient("dummy_token", console);
		// Mock do node-telegram-bot-api
		tgClient.bot.getUserProfilePhotos = async (userId, opts) => {
			assert.strictEqual(userId, 123456789);
			return {
				total_count: 1,
				photos: [
					[
						{ file_id: "small_id", width: 160 },
						{ file_id: "best_photo_id", width: 640 }
					]
				]
			};
		};
		tgClient.bot.getFileLink = async (fileId) => {
			assert.strictEqual(fileId, "best_photo_id", "Deve solicitar o link da maior foto");
			return "https://api.telegram.org/file/bot_token/photos/file_0.jpg";
		};

		const url = await tgClient.getUserProfilePhotoUrl("123456789");
		assert.strictEqual(
			url,
			"https://api.telegram.org/file/bot_token/photos/file_0.jpg",
			"Deve retornar a URL da melhor foto de perfil"
		);

		// Teste quando usuário não tem foto ou privacidade restrita
		tgClient.bot.getUserProfilePhotos = async () => ({ total_count: 0, photos: [] });
		const noPhoto = await tgClient.getUserProfilePhotoUrl("987654321");
		assert.strictEqual(noPhoto, null, "Deve retornar null se não houver foto de perfil pública");
		console.log("✓ TelegramClient.getUserProfilePhotoUrl validado com sucesso.");
	}

	// ─── 5. TESTE: PROFILEPICTUREHELPER COM TELEGRAMBOT ──────────────────────────
	console.log("\n[5] Testando ProfilePictureHelper.fetchUserProfilePictureMedia com Telegram...");
	{
		const botTg = new FakeBot({ id: "tg_test" });
		botTg.useTelegram = true;
		botTg.getProfilePictureUrl = async (userId) => "https://api.telegram.org/file/fake_profile.jpg";

		// Mock axios.get
		const axios = require("axios");
		const origGet = axios.get;
		axios.get = async (url) => {
			if (url === "https://api.telegram.org/file/fake_profile.jpg") {
				return {
					data: Buffer.from("fake-avatar-bytes")
				};
			}
			return origGet(url);
		};

		try {
			const media = await ProfilePictureHelper.fetchUserProfilePictureMedia(botTg, "123456789");
			assert.ok(media, "Deve retornar o objeto de mídia para Telegram");
			assert.strictEqual(media.isMessageMedia, true);
			assert.strictEqual(media.data, Buffer.from("fake-avatar-bytes").toString("base64"));
			console.log("✓ ProfilePictureHelper baixou a foto do Telegram com sucesso.");
		} finally {
			axios.get = origGet;
		}
	}

	// ─── 6. TESTE: PROFILEPICTUREHELPER COM WHATSAPP FALLBACK LID -> PN ──────────
	console.log("\n[6] Testando ProfilePictureHelper fallback de LID para PN no WhatsApp...");
	{
		const botWa = new FakeBot({ id: "wa_test" });
		botWa.useTelegram = false;
		botWa.useDiscord = false;
		botWa.getPnFromLid = (lid) => {
			if (lid.includes("321321321")) return "5511999998888";
			return null;
		};

		botWa.getProfilePictureUrl = async (target) => {
			// Simula: falha se for LID, sucesso se for PN
			if (target.includes("@lid")) return null;
			if (target.includes("5511999998888")) return "https://pps.whatsapp.net/pfp.jpg";
			return null;
		};

		const axios = require("axios");
		const origGet = axios.get;
		axios.get = async (url) => {
			if (url === "https://pps.whatsapp.net/pfp.jpg") {
				return { data: Buffer.from("wa-avatar-bytes") };
			}
			return origGet(url);
		};

		try {
			const media = await ProfilePictureHelper.fetchUserProfilePictureMedia(botWa, "321321321@lid");
			assert.ok(media, "Deve obter mídia via fallback para PN");
			assert.strictEqual(media.data, Buffer.from("wa-avatar-bytes").toString("base64"));
			console.log("✓ ProfilePictureHelper fallback de LID para PN validado.");
		} finally {
			axios.get = origGet;
		}
	}

	// ─── 7. TESTE: CUSTOMVARIABLEPROCESSOR {fotoPerfil} NO TELEGRAM ─────────────
	console.log("\n[7] Testando CustomVariableProcessor com {fotoPerfil} no Telegram...");
	{
		const botTg = new FakeBot({ id: "tg_test" });
		botTg.useTelegram = true;
		botTg.getProfilePictureUrl = async () => "https://api.telegram.org/pfp.jpg";

		const axios = require("axios");
		const origGet = axios.get;
		axios.get = async (url) => {
			if (url === "https://api.telegram.org/pfp.jpg") {
				return { data: Buffer.from("tg-user-avatar") };
			}
			return origGet(url);
		};

		try {
			const processor = new CustomVariableProcessor(botTg.database);
			const msg = createMessage({
				author: "987654321",
				content: "Minha foto {fotoPerfil}"
			});

			const context = {
				bot: botTg,
				message: msg,
				options: {}
			};

			const result = await processor.process("Minha foto {fotoPerfil}", context);
			assert.ok(result, "Deve retornar resultado de mídia");
			assert.strictEqual(result.isMessageMedia, true, "Deve retornar MessageMedia");
			assert.strictEqual(context.options.caption, "Minha foto", "Deve definir caption");
			console.log("✓ {fotoPerfil} processado com sucesso no Telegram!");
		} finally {
			axios.get = origGet;
		}
	}

	console.log("\n========================================================");
	console.log("✓ TODOS OS TESTES PASSARAM COM SUCESSO (100% OK)!");
	console.log("========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NOS TESTES:", err);
		process.exit(1);
	});
