process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");
const FakeBot = require("./FakeBot");
const Management = require("../commands/Management");
const StreamSystem = require("../StreamSystem");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== INICIANDO TESTES: Mudar Foto do Grupo em Lives ===");

	const testGroupId = "120363000000000001@g.us";
	const bot = new FakeBot({
		id: "bot-test",
		phoneNumber: "5511999990000",
		grupoLogs: "120363000000000002@g.us"
	});

	const management = new Management();
	const streamSystem = StreamSystem.getInstance();
	streamSystem.registerBot(bot);

	// Mock axios para o teste sem precisar de requisições externas de rede
	const axios = require("axios");
	const originalAxiosGet = axios.get;
	const fakeJpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
	axios.get = async (url, options) => {
		if (url.includes("avatar") || url.includes("thumbnail")) {
			return { data: fakeJpegBuffer };
		}
		return originalAxiosGet(url, options);
	};

	try {
		// Mock do grupo no banco de dados do FakeBot
		const groupData = {
			id: testGroupId,
			name: "Grupo Teste Live",
			titulo: "Grupo Teste Live",
			prefix: "!",
			twitch: [
				{
					channel: "streamer_teste",
					changePhotoOnEvent: false,
					changeTitleOnEvent: false
				}
			],
			kick: [
				{
					channel: "streamer_kick",
					changePhotoOnEvent: false
				}
			],
			youtube: [
				{
					channel: "canal_yt",
					notifyLives: true,
					changePhotoOnEvent: false
				}
			]
		};

		await bot.database.saveGroup(groupData);

		// -------------------------------------------------------------
		// Teste 1: Toggle mudarFoto via Management.js (!g-twitch-mudarFoto)
		// -------------------------------------------------------------
		console.log("\n1. Testando toggle de mudarFoto no Management.js...");

		const msgToggle = createMessage({
			content: "!g-twitch-mudarFoto streamer_teste",
			group: testGroupId,
			author: "5511999991111@s.whatsapp.net"
		});

		// 1.1 Ativa
		let res = await management.toggleTwitchPhotoChange(
			bot,
			msgToggle,
			["streamer_teste"],
			groupData
		);
		assert.ok(res && res.content.includes("ativada"), "Deveria ativar mudar foto para Twitch");
		assert.strictEqual(
			groupData.twitch[0].changePhotoOnEvent,
			true,
			"changePhotoOnEvent deve ser true"
		);

		// 1.2 Desativa
		res = await management.toggleTwitchPhotoChange(bot, msgToggle, ["streamer_teste"], groupData);
		assert.ok(
			res && res.content.includes("desativada"),
			"Deveria desativar mudar foto para Twitch"
		);
		assert.strictEqual(
			groupData.twitch[0].changePhotoOnEvent,
			false,
			"changePhotoOnEvent deve voltar para false"
		);

		console.log("✓ Toggle mudarFoto funcionou corretamente.");

		// -------------------------------------------------------------
		// Teste 2: Definir foto SEM mídia anexada (captura automática da foto atual do grupo)
		// -------------------------------------------------------------
		console.log("\n2. Testando captura automática da foto atual do grupo...");

		bot.profilePictureUrl = "https://example.com/avatar_atual_grupo.jpg";

		const msgSemFoto = createMessage({
			content: "!g-twitch-fotoGrupo off streamer_teste",
			group: testGroupId,
			author: "5511999991111@s.whatsapp.net"
		});

		res = await management.setTwitchGroupPhoto(
			bot,
			msgSemFoto,
			["off", "streamer_teste"],
			groupData
		);
		assert.ok(
			res && res.content.includes("Foto atual do grupo capturada"),
			"Deveria avisar que capturou a foto atual do grupo"
		);
		assert.ok(groupData.twitch[0].groupPhotoOffline, "groupPhotoOffline deve ter sido definido");
		assert.strictEqual(
			groupData.twitch[0].changePhotoOnEvent,
			true,
			"Deve ativar automaticamente changePhotoOnEvent"
		);

		// Limpa o arquivo criado
		const offlinePath = path.join(
			management.dataPath,
			"media",
			groupData.twitch[0].groupPhotoOffline
		);
		await fs.unlink(offlinePath).catch(() => {});

		console.log("✓ Captura automática da foto do grupo funcionou com sucesso.");

		// -------------------------------------------------------------
		// Teste 3: Definir foto COM mídia anexada / citada
		// -------------------------------------------------------------
		console.log("\n3. Testando definição com mídia anexada...");

		const msgComFoto = createMessage({
			content: {
				data: fakeJpegBuffer.toString("base64"),
				mimetype: "image/jpeg"
			},
			type: "image",
			group: testGroupId,
			author: "5511999991111@s.whatsapp.net"
		});

		res = await management.setTwitchGroupPhoto(
			bot,
			msgComFoto,
			["on", "streamer_teste"],
			groupData
		);
		assert.ok(
			res && res.content.includes("Foto enviada configurada"),
			"Deveria configurar com mídia enviada"
		);
		assert.ok(groupData.twitch[0].groupPhotoOnline, "groupPhotoOnline deve ter sido definido");

		// Limpa o arquivo criado
		const onlinePath = path.join(
			management.dataPath,
			"media",
			groupData.twitch[0].groupPhotoOnline
		);
		await fs.unlink(onlinePath).catch(() => {});

		console.log("✓ Definição de foto enviada funcionou com sucesso.");

		// -------------------------------------------------------------
		// Teste 4: Remoção de foto via comando del
		// -------------------------------------------------------------
		console.log("\n4. Testando remoção de foto via comando del...");

		res = await management.setTwitchGroupPhoto(
			bot,
			msgSemFoto,
			["del", "on", "streamer_teste"],
			groupData
		);
		assert.ok(res && res.content.includes("removida"), "Deveria remover a foto online");
		assert.strictEqual(
			groupData.twitch[0].groupPhotoOnline,
			undefined,
			"groupPhotoOnline deve ser undefined"
		);

		console.log("✓ Remoção de foto funcionou com sucesso.");

		// -------------------------------------------------------------
		// Teste 5: Pipeline StreamSystem (Online / Offline e Restauração)
		// -------------------------------------------------------------
		console.log("\n5. Testando pipeline do StreamSystem...");

		bot.capturedGroupPictures = [];
		streamSystem.cachedGroupPhotos.clear();

		// 5.1 Quando changePhotoOnEvent == false: NÃO deve alterar foto
		groupData.twitch[0].changePhotoOnEvent = false;
		delete groupData.twitch[0].groupPhotoOnline;
		delete groupData.twitch[0].groupPhotoOffline;

		await streamSystem.changeGroupPhotoForStream(
			bot,
			groupData,
			groupData.twitch[0],
			{ thumbnail: "https://example.com/stream-thumb.jpg" },
			"online"
		);
		assert.strictEqual(
			bot.capturedGroupPictures.length,
			0,
			"Não deve alterar foto quando changePhotoOnEvent for false"
		);

		// 5.2 Quando changePhotoOnEvent == true e Online: deve usar thumbnail e salvar cache
		groupData.twitch[0].changePhotoOnEvent = true;
		bot.profilePictureUrl = "https://example.com/avatar_original.jpg";

		await streamSystem.changeGroupPhotoForStream(
			bot,
			groupData,
			groupData.twitch[0],
			{ thumbnail: "https://example.com/stream-thumb.jpg" },
			"online"
		);

		assert.strictEqual(
			bot.capturedGroupPictures.length,
			1,
			"Deveria ter chamado setPicture uma vez"
		);
		assert.strictEqual(
			bot.capturedGroupPictures[0].picture,
			"https://example.com/stream-thumb.jpg",
			"Deveria usar a thumbnail da live"
		);
		assert.strictEqual(
			streamSystem.cachedGroupPhotos.get(testGroupId),
			"https://example.com/avatar_original.jpg",
			"Deveria guardar a foto original em cache"
		);

		// 5.3 Quando Offline: deve restaurar a foto que estava em cache
		bot.capturedGroupPictures = [];
		await streamSystem.changeGroupPhotoForStream(
			bot,
			groupData,
			groupData.twitch[0],
			{},
			"offline"
		);

		assert.strictEqual(
			bot.capturedGroupPictures.length,
			1,
			"Deveria ter chamado setPicture para restaurar"
		);
		assert.strictEqual(
			bot.capturedGroupPictures[0].picture,
			"https://example.com/avatar_original.jpg",
			"Deveria restaurar o avatar original"
		);
		assert.strictEqual(
			streamSystem.cachedGroupPhotos.has(testGroupId),
			false,
			"Cache deve ter sido consumido"
		);

		console.log("✓ Pipeline do StreamSystem funcionou perfeitamente.");

		console.log("\n========================================================");
		console.log("   TODOS OS TESTES DE TROCA DE FOTO DE LIVES PASSARAM!   ");
		console.log("========================================================");

		process.exit(0);
	} catch (err) {
		console.error("Falha no teste:", err);
		process.exit(1);
	} finally {
		axios.get = originalAxiosGet;
	}
}

main();
