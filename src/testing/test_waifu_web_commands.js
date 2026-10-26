"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando Testes dos Comandos Web do Waifuletes (!mu-adm e !mu-share) ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();

	// 1. Validar registro dos comandos
	console.log("[Teste 1] Validando registro e aliases dos comandos web...");
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	const cmdNames = new Set(WaifuCommands.commands.map((c) => c.name));
	assert.ok(cmdNames.has("mu-adm"), "Comando !mu-adm deve estar registrado");
	assert.ok(cmdNames.has("mu-admin"), "Alias !mu-admin deve estar registrado");
	assert.ok(cmdNames.has("mu-share"), "Comando !mu-share deve estar registrado");
	assert.ok(cmdNames.has("mu-compartilhar"), "Alias !mu-compartilhar deve estar registrado");
	assert.ok(cmdNames.has("waifinder"), "Comando !waifinder deve estar registrado");
	assert.ok(cmdNames.has("mu-waifinder"), "Alias !mu-waifinder deve estar registrado");
	assert.ok(cmdNames.has("mu-tinder"), "Alias !mu-tinder deve estar registrado");
	assert.ok(cmdNames.has("mu-waifu"), "Comando !mu-waifu deve continuar registrado");
	console.log("✓ Todos os comandos web e aliases estão registrados!");

	// Mock do axios 'api' interno do WaifuCommands
	const originalPost = WaifuCommands.api.post;
	const originalGet = WaifuCommands.api.get;

	async function waitForCaptured(targetCount, maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length >= targetCount) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 50));
		}
		return bot.capturedMessages;
	}

	try {
		// Mock de dados da API Waifuletes
		WaifuCommands.api.post = async (url, body) => {
			if (url === "/user/ensure") {
				return { data: { success: true } };
			}
			if (url === "/user/session") {
				return {
					data: {
						success: true,
						data: {
							publicId: "u-1234-uuid",
							token: "tok-abcd-5678",
							url: "https://waifuletes.moothz.win/user/u-1234-uuid?token=tok-abcd-5678",
							waifinderUrl: "https://waifuletes.moothz.win/catalogo?token=tok-abcd-5678",
							expiresIn: 1800
						}
					}
				};
			}
			throw new Error(`Unexpected post url: ${url}`);
		};

		WaifuCommands.api.get = async (url) => {
			if (url.startsWith("/user/")) {
				return {
					data: {
						success: true,
						data: {
							id: "5511999999999",
							name: "RaveninhaFan",
							publicId: "u-1234-uuid",
							publicUrl: "https://waifuletes.moothz.win/user/u-1234-uuid",
							haremCount: 25,
							soulmateCount: 2,
							wishlistCount: 5,
							favoriteCharacter: {
								id: "char-1",
								name: "Frieren",
								series: "Sousou no Frieren"
							}
						}
					}
				};
			}
			throw new Error(`Unexpected get url: ${url}`);
		};

		// 2. Testar !mu-adm chamado dentro de um GRUPO
		console.log("[Teste 2] Testando !mu-adm disparado em GRUPO...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgGrupo = createMessage({
			content: "!mu-adm",
			group: "120363000000000000@g.us",
			author: "5511999999999@s.whatsapp.net",
			authorName: "RaveninhaFan"
		});

		await eventHandler.processMessage(bot, msgGrupo);

		// Deve haver 1 mensagem capturada enviada diretamente no PV do autor (com o link secreto e token)
		// e reação no grupo
		const captured = await waitForCaptured(1);
		assert.ok(
			captured.length >= 1,
			`Esperado ao menos 1 mensagem no PV, recebido ${captured.length}`
		);

		const pvMsg = captured.find((m) => m.chatId === "5511999999999@s.whatsapp.net");
		assert.ok(pvMsg, "Mensagem no PV do usuário deve ter sido enviada");
		assert.ok(
			pvMsg.content.includes("https://waifuletes.moothz.win/user/u-1234-uuid?token=tok-abcd-5678"),
			"Mensagem de PV deve conter a URL com o token de 30 minutos"
		);
		assert.ok(
			pvMsg.content.includes("30 minutos"),
			"Mensagem de PV deve informar a duração de 30 minutos"
		);
		console.log("✓ !mu-adm em grupo enviou link no PV com sucesso!");

		// 3. Testar !mu-admin chamado direto no PRIVADO
		console.log("[Teste 3] Testando !mu-admin disparado diretamente no PV...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgPv = createMessage({
			content: "!mu-admin",
			group: null,
			author: "5511999999999@s.whatsapp.net",
			authorName: "RaveninhaFan"
		});

		await eventHandler.processMessage(bot, msgPv);

		const capturedPv = await waitForCaptured(1);
		assert.strictEqual(capturedPv.length, 1, "Esperada 1 resposta no PV");
		const directPvMsg = capturedPv[0];
		assert.strictEqual(directPvMsg.chatId, "5511999999999@s.whatsapp.net");
		assert.ok(
			directPvMsg.content.includes(
				"https://waifuletes.moothz.win/user/u-1234-uuid?token=tok-abcd-5678"
			),
			"Resposta direta no PV deve conter o link do painel"
		);
		console.log("✓ !mu-admin direto no PV respondeu com o link com sucesso!");

		// 4. Testar !mu-share em grupo
		console.log("[Teste 4] Testando !mu-share...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgShare = createMessage({
			content: "!mu-share",
			group: "120363000000000000@g.us",
			author: "5511999999999@s.whatsapp.net",
			authorName: "RaveninhaFan"
		});

		await eventHandler.processMessage(bot, msgShare);

		const capturedShare = await waitForCaptured(1);
		assert.strictEqual(capturedShare.length, 1, "Esperada 1 mensagem no grupo para !mu-share");
		const shareMsg = capturedShare[0];
		assert.strictEqual(shareMsg.chatId, "120363000000000000@g.us");
		assert.ok(
			shareMsg.content.includes("https://waifuletes.moothz.win/user/u-1234-uuid"),
			"Mensagem deve conter o link público sem token"
		);
		assert.ok(
			!shareMsg.content.includes("?token="),
			"Mensagem pública de compartilhamento NUNCA deve conter tokens"
		);
		assert.ok(
			shareMsg.content.includes("25 waifus/husbandos"),
			"Deve informar quantidade de colecionados"
		);
		assert.ok(shareMsg.content.includes("Frieren"), "Deve informar a waifu favorita");
		console.log("✓ !mu-share gerou link público sem token e com estatísticas do harém!");

		// 5. Testar alias !mu-compartilhar
		console.log("[Teste 5] Testando alias !mu-compartilhar...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgCompartilhar = createMessage({
			content: "!mu-compartilhar",
			group: "120363000000000000@g.us",
			author: "5511999999999@s.whatsapp.net",
			authorName: "RaveninhaFan"
		});

		await eventHandler.processMessage(bot, msgCompartilhar);

		const capturedCompartilhar = await waitForCaptured(1);
		assert.strictEqual(capturedCompartilhar.length, 1);
		assert.ok(
			capturedCompartilhar[0].content.includes("https://waifuletes.moothz.win/user/u-1234-uuid"),
			"Alias deve produzir o mesmo link público"
		);
		console.log("✓ !mu-compartilhar funcionou perfeitamente!");

		// 6. Testar !waifinder disparado em GRUPO
		console.log("[Teste 6] Testando !waifinder disparado em GRUPO...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgWaifinder = createMessage({
			content: "!waifinder",
			group: "120363000000000000@g.us",
			author: "5511999999999@s.whatsapp.net",
			authorName: "RaveninhaFan"
		});

		await eventHandler.processMessage(bot, msgWaifinder);

		const capturedWaifinder = await waitForCaptured(1);
		assert.ok(capturedWaifinder.length >= 1, "Mensagem no PV do usuário deve ter sido enviada");
		const pvWaifinderMsg = capturedWaifinder.find(
			(m) => m.chatId === "5511999999999@s.whatsapp.net"
		);
		assert.ok(pvWaifinderMsg, "Mensagem no PV deve ter sido enviada");
		assert.ok(
			pvWaifinderMsg.content.includes("https://waifuletes.moothz.win/catalogo?token=tok-abcd-5678"),
			"Mensagem de PV deve conter a URL do Waifinder com o token"
		);
		assert.ok(
			pvWaifinderMsg.content.includes("Waifinder"),
			"Mensagem de PV deve conter o título Waifinder"
		);
		assert.strictEqual(
			pvWaifinderMsg.content.includes("30 minutos"),
			false,
			"Mensagem do Waifinder não deve conter texto de expiração"
		);
		console.log("✓ !waifinder enviou link no PV sem texto de expiração de token!");

		// 7. Testar alias !mu-tinder disparado em PV
		console.log("[Teste 7] Testando alias !mu-tinder disparado em PV...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgTinderPv = createMessage({
			content: "!mu-tinder",
			author: "5511999999999@s.whatsapp.net",
			authorName: "RaveninhaFan"
		});

		await eventHandler.processMessage(bot, msgTinderPv);

		const capturedTinder = await waitForCaptured(1);
		assert.strictEqual(capturedTinder.length, 1);
		assert.ok(
			capturedTinder[0].content.includes(
				"https://waifuletes.moothz.win/catalogo?token=tok-abcd-5678"
			),
			"Alias !mu-tinder deve gerar o mesmo link do Waifinder"
		);
		console.log("✓ !mu-tinder respondeu diretamente no PV!");

		console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! 🎉");
	} finally {
		WaifuCommands.api.post = originalPost;
		WaifuCommands.api.get = originalGet;
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha nos testes:", err);
		process.exit(1);
	});
