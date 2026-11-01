"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const { registerFeaturesRoutes } = require("../BotAPI/routes/featuresRoutes");
const WaifuMarriagePhotoHelper = require("../utils/WaifuMarriagePhotoHelper");

async function runTests() {
	console.log(
		"=== Iniciando Testes de Integração Waifuletes (Privacidade, Ordem, Fotos & Rota BotAPI) ==="
	);

	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us" });
	const eventHandler = new EventHandler();
	const testGroup = "120363000000000000@g.us";

	// 1. Validar registro dos comandos
	console.log("\n[Teste 1] Validando registro dos novos comandos...");
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	const cmdNames = new Set(WaifuCommands.commands.map((c) => c.name));
	assert.ok(cmdNames.has("mu-harem-privado"), "Comando !mu-harem-privado deve estar registrado");
	assert.ok(cmdNames.has("mu-hprivado"), "Alias !mu-hprivado deve estar registrado");
	assert.ok(cmdNames.has("mu-col-privada"), "Comando !mu-col-privada deve estar registrado");
	assert.ok(cmdNames.has("mu-col-priv"), "Alias !mu-col-priv deve estar registrado");
	assert.ok(cmdNames.has("mu-col-ordem"), "Comando !mu-col-ordem deve estar registrado");
	assert.ok(cmdNames.has("mu-col-ordenar"), "Alias !mu-col-ordenar deve estar registrado");
	assert.ok(cmdNames.has("mu-harem-foto"), "Comando !mu-harem-foto deve estar registrado");
	assert.ok(cmdNames.has("mu-hfoto"), "Alias !mu-hfoto deve estar registrado");
	console.log("✓ Todos os novos comandos registrados com sucesso!");

	// Backup dos métodos originais da api
	const origGet = WaifuCommands.api.get;
	const origPost = WaifuCommands.api.post;
	const origPut = WaifuCommands.api.put;
	const origPatch = WaifuCommands.api.patch;

	const testUserSelf = "5511999990001@s.whatsapp.net";
	const testUserOther = "5511999990002@s.whatsapp.net";
	const normSelf = "5511999990001";
	const normOther = "5511999990002";

	// Estado mockado para os testes
	const mockUserPrivacy = {
		[normSelf]: false,
		[normOther]: false
	};

	const mockCollections = [
		{
			id: "col-1",
			userId: normSelf,
			name: "Isekai",
			description: "Waifus de outro mundo",
			isPrivate: false,
			characterCount: 1,
			characters: [
				{
					id: "rem-re-zero",
					name: "Rem",
					series: "Re:Zero",
					baseRarity: "LEGENDARY",
					keys: 10,
					isFavorite: true
				}
			]
		},
		{
			id: "col-2",
			userId: normSelf,
			name: "Secretas",
			description: "Pasta privada",
			isPrivate: true,
			characterCount: 1,
			characters: [
				{
					id: "emilia-re-zero",
					name: "Emilia",
					series: "Re:Zero",
					baseRarity: "EPIC",
					keys: 5,
					isFavorite: false
				}
			]
		}
	];

	const mockPinnedPhotos = {};

	// Mock do client axios WaifuCommands.api
	WaifuCommands.api.get = async (url, config) => {
		if (url.startsWith("/harem/") && url.includes("/photos")) {
			const parts = url.split("/");
			const userId = parts[2];
			const charId = parts[3];
			return {
				data: {
					success: true,
					data: {
						characterId: charId,
						characterName: charId === "rem-re-zero" ? "Rem" : "Personagem",
						pinnedPhoto: mockPinnedPhotos[`${userId}:${charId}`] || null,
						photos: [
							{
								index: 1,
								id: "photo1.jpg",
								url: "http://photo1.jpg",
								isPinned: mockPinnedPhotos[`${userId}:${charId}`] === "photo1.jpg"
							},
							{
								index: 2,
								id: "photo2.jpg",
								url: "http://photo2.jpg",
								isPinned: mockPinnedPhotos[`${userId}:${charId}`] === "photo2.jpg"
							}
						],
						marriage: {
							exists: true,
							url: `http://marriage-${charId}.jpg`,
							isPinned: mockPinnedPhotos[`${userId}:${charId}`] === "marriage"
						}
					}
				}
			};
		}

		if (url.startsWith("/harem/")) {
			const parts = url.split("/");
			const userId = parts[2];
			const isOther = userId === normOther;
			const isPriv = mockUserPrivacy[userId] || false;

			return {
				data: {
					success: true,
					data: {
						total: isOther ? 1 : 1,
						page: 1,
						limit: 15,
						totalPages: 1,
						haremName: isOther ? "Harém Secreto" : "Meu Harém",
						userName: isOther ? "Outro Jogador" : "Jogador Teste",
						haremPrivate: isPriv,
						data: [
							{
								id: "entry-1",
								keys: 10,
								isFavorite: true,
								collectionId: null,
								character: {
									id: isOther ? "aqua-konosuba" : "megumin-konosuba",
									name: isOther ? "Aqua" : "Megumin",
									series: "Konosuba",
									baseRarity: "LEGENDARY"
								}
							}
						]
					}
				}
			};
		}

		if (url.startsWith("/user/") && url.endsWith("/collections")) {
			const userId = url.split("/")[2];
			const isOther = userId === normOther;
			if (isOther) {
				return {
					data: {
						success: true,
						data: [
							{
								id: "col-other-pub",
								name: "Pública Outro",
								isPrivate: false,
								characterCount: 1,
								characters: [{ id: "aqua-konosuba", name: "Aqua", series: "Konosuba", keys: 5 }]
							},
							{
								id: "col-other-priv",
								name: "Privada Outro",
								isPrivate: true,
								characterCount: 1,
								characters: [
									{ id: "darkness-konosuba", name: "Darkness", series: "Konosuba", keys: 2 }
								]
							}
						]
					}
				};
			}
			return {
				data: {
					success: true,
					data: mockCollections
				}
			};
		}

		if (url.startsWith("/characters/")) {
			const idOrQuery = decodeURIComponent(url.replace("/characters/", ""));
			return {
				data: {
					success: true,
					data: {
						id: idOrQuery === "Rem" ? "rem-re-zero" : idOrQuery,
						name: idOrQuery === "rem-re-zero" || idOrQuery === "Rem" ? "Rem" : idOrQuery,
						series: "Re:Zero",
						baseRarity: "LEGENDARY",
						imageUrl: "http://rem.jpg"
					}
				}
			};
		}

		if (url === "/characters") {
			return {
				data: {
					success: true,
					data: {
						data: [
							{
								id: "rem-re-zero",
								name: "Rem",
								series: "Re:Zero",
								baseRarity: "LEGENDARY"
							}
						]
					}
				}
			};
		}

		return { data: { success: true, data: [] } };
	};

	WaifuCommands.api.patch = async (url, body) => {
		if (url.startsWith("/harem/") && url.endsWith("/privacy")) {
			const userId = url.split("/")[2];
			mockUserPrivacy[userId] = body.isPrivate;
			return {
				data: {
					success: true,
					data: {
						userId,
						haremPrivate: body.isPrivate,
						message: body.isPrivate
							? "Harém definido como privado."
							: "Harém definido como público."
					}
				}
			};
		}

		if (url.startsWith("/user/") && url.includes("/collections/") && url.endsWith("/privacy")) {
			const colId = url.split("/")[4];
			const col = mockCollections.find((c) => c.id === colId);
			if (col) {
				col.isPrivate = typeof body?.isPrivate === "boolean" ? body.isPrivate : !col.isPrivate;
				return {
					data: {
						success: true,
						data: {
							id: col.id,
							name: col.name,
							isPrivate: col.isPrivate
						}
					}
				};
			}
		}

		return { data: { success: true } };
	};

	WaifuCommands.api.put = async (url, body) => {
		if (url.startsWith("/user/") && url.endsWith("/collections/order")) {
			const order = body.order || [];
			mockCollections.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
			return {
				data: {
					success: true,
					data: {
						collections: mockCollections
					}
				}
			};
		}

		if (url.startsWith("/harem/") && url.includes("/photo")) {
			const parts = url.split("/");
			const userId = parts[2];
			const charId = parts[3];
			mockPinnedPhotos[`${userId}:${charId}`] = body.photo;
			return {
				data: {
					success: true,
					data: {
						pinnedPhoto: body.photo,
						message: body.photo
							? "Foto fixa definida com sucesso."
							: "Voltou a exibir fotos aleatórias."
					}
				}
			};
		}

		return { data: { success: true } };
	};

	async function waitForCaptured(targetCount, maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length >= targetCount) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 50));
		}
		return bot.capturedMessages;
	}

	// ── Teste 2: !mu-harem-privado ─────────────────────────────────────────────
	console.log("\n[Teste 2] Testando alternância de privacidade do Harém (!mu-harem-privado)...");
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	mockUserPrivacy[normSelf] = false;

	const msgPriv1 = createMessage({
		content: "!mu-harem-privado",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgPriv1);
	await waitForCaptured(1);

	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(mockUserPrivacy[normSelf] === true, "Privacidade deve ter sido alternada para true");
	assert.ok(
		bot.capturedMessages[0].content.includes("PRIVADO"),
		"Mensagem de retorno deve indicar que o harém agora é PRIVADO"
	);
	console.log("✓ Harém alternado para PRIVADO com sucesso!");

	// Alterna de volta para público
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgPriv2 = createMessage({
		content: "!mu-harem-privado",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgPriv2);
	await waitForCaptured(1);

	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(mockUserPrivacy[normSelf] === false, "Privacidade deve ter sido alternada para false");
	assert.ok(
		bot.capturedMessages[0].content.includes("PÚBLICO"),
		"Mensagem de retorno deve indicar que o harém agora é PÚBLICO"
	);
	console.log("✓ Harém alternado de volta para PÚBLICO com sucesso!");

	// ── Teste 3: !mu-col-privada <pasta> ───────────────────────────────────────
	console.log("\n[Teste 3] Testando alternância de privacidade de coleção (!mu-col-privada)...");
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();

	const msgColPriv1 = createMessage({
		content: "!mu-col-privada Isekai",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgColPriv1);
	await waitForCaptured(1);

	assert.strictEqual(bot.capturedMessages.length, 1);
	const isekaiCol = mockCollections.find((c) => c.name === "Isekai");
	assert.ok(isekaiCol.isPrivate === true, "Coleção Isekai deve ter se tornado privada");
	assert.ok(
		bot.capturedMessages[0].content.includes("PRIVADA"),
		"Mensagem de retorno deve indicar que a coleção agora é PRIVADA"
	);
	console.log("✓ Coleção Isekai definida como PRIVADA!");

	// Alterna de volta
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgColPriv2 = createMessage({
		content: "!mu-col-privada Isekai",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgColPriv2);
	await waitForCaptured(1);

	assert.ok(isekaiCol.isPrivate === false, "Coleção Isekai deve ter se tornado pública novamente");
	assert.ok(
		bot.capturedMessages[0].content.includes("PÚBLICA"),
		"Mensagem de retorno deve indicar que a coleção agora é PÚBLICA"
	);
	console.log("✓ Coleção Isekai restaurada para PÚBLICA!");

	// ── Teste 4: !mu-col-ordem <pasta1> | <pasta2> ──────────────────────────────
	console.log("\n[Teste 4] Testando reordenação de coleções (!mu-col-ordem)...");
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();

	const msgColOrdem = createMessage({
		content: "!mu-col-ordem Secretas | Isekai",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgColOrdem);
	await waitForCaptured(1);

	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.strictEqual(mockCollections[0].name, "Secretas", "Secretas deve ser a primeira coleção");
	assert.strictEqual(mockCollections[1].name, "Isekai", "Isekai deve ser a segunda coleção");
	assert.ok(
		bot.capturedMessages[0].content.includes("Ordem das coleções atualizada"),
		"Mensagem deve confirmar atualização da ordem"
	);
	console.log("✓ Coleções reordenadas com sucesso!");

	// ── Teste 5: !mu-harem-foto <personagem> [índice | casamento | reset] ──────
	console.log("\n[Teste 5] Testando gerenciamento de fotos do card (!mu-harem-foto)...");
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();

	// 5.1 Consulta fotos disponíveis
	const msgFotoList = createMessage({
		content: "!mu-harem-foto Rem",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFotoList);
	await waitForCaptured(1);

	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(
		bot.capturedMessages[0].content.includes("Opções de Foto para Rem"),
		"Deve listar opções de foto de Rem"
	);
	assert.ok(
		bot.capturedMessages[0].content.includes("Foto *1*") &&
			bot.capturedMessages[0].content.includes("Foto *2*"),
		"Deve exibir as fotos do catálogo"
	);
	console.log("✓ Consulta de fotos listada com sucesso!");

	// 5.2 Fixa foto 2 do catálogo
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgFotoSet2 = createMessage({
		content: "!mu-harem-foto Rem 2",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFotoSet2);
	await waitForCaptured(1);

	assert.strictEqual(mockPinnedPhotos[`${normSelf}:rem-re-zero`], 2, "Foto 2 deve ter sido fixada");
	console.log("✓ Foto 2 do catálogo fixada com sucesso!");

	// 5.3 Fixa foto de casamento
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgFotoSetCasamento = createMessage({
		content: "!mu-harem-foto Rem casamento",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFotoSetCasamento);
	await waitForCaptured(1);

	assert.strictEqual(
		mockPinnedPhotos[`${normSelf}:rem-re-zero`],
		"marriage",
		"Foto de casamento deve ter sido fixada"
	);
	assert.ok(
		bot.capturedMessages[0].content.includes("casamento"),
		"Mensagem deve confirmar fixação da foto de casamento"
	);
	console.log("✓ Foto de casamento fixada com sucesso!");

	// 5.4 Reseta para fotos aleatórias
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgFotoReset = createMessage({
		content: "!mu-harem-foto Rem reset",
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFotoReset);
	await waitForCaptured(1);

	assert.strictEqual(
		mockPinnedPhotos[`${normSelf}:rem-re-zero`],
		null,
		"Foto fixada deve ser resetada para null"
	);
	assert.ok(
		bot.capturedMessages[0].content.includes("aleatórias"),
		"Mensagem deve confirmar retorno a fotos aleatórias"
	);
	console.log("✓ Reset para fotos aleatórias executado com sucesso!");

	// ── Teste 6: !mu-harem @usuario (Visualização pública e privacidade) ─────────
	console.log("\n[Teste 6] Testando !mu-harem @usuario com harém privado e pastas ocultas...");

	// 6.1 Harém do outro usuário está privado
	mockUserPrivacy[normOther] = true;
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();

	const msgHaremPriv = createMessage({
		content: "!mu-harem @5511999990002",
		mentions: [testUserOther],
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgHaremPriv);
	await waitForCaptured(1);

	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(
		bot.capturedMessages[0].content.includes("Harém Privado!"),
		"Deve bloquear visualização e informar que o harém foi privado"
	);
	console.log("✓ Harém privado de outro jogador bloqueado com sucesso!");

	// 6.2 Harém do outro usuário é público: deve exibir apenas coleções públicas e ocultar as privadas
	mockUserPrivacy[normOther] = false;
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();

	const msgHaremPub = createMessage({
		content: "!mu-harem @5511999990002",
		mentions: [testUserOther],
		author: testUserSelf,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgHaremPub);
	await waitForCaptured(1);

	assert.strictEqual(bot.capturedMessages.length, 1);
	const haremText = bot.capturedMessages[0].content;
	assert.ok(haremText.includes("Pública Outro"), "Coleção pública deve estar visível");
	assert.ok(
		!haremText.includes("Privada Outro"),
		"Coleção privada JAMAIS deve estar visível para outro usuário"
	);
	assert.ok(
		!haremText.includes("Darkness"),
		"Waifus de coleção privada NÃO devem aparecer no harém de outro usuário"
	);
	console.log("✓ Visualização de harém de outro usuário respeita coleções privadas com sucesso!");

	// ── Teste 7: Rota BotAPI de Foto de Casamento ───────────────────────────────
	console.log(
		"\n[Teste 7] Testando endpoint BotAPI GET /api/waifuletes/marriage-photo/:characterId..."
	);

	// Mock do express app
	const routes = {};
	const fakeApp = {
		get(path, ...handlers) {
			routes[path] = handlers[handlers.length - 1];
		},
		post() {},
		put() {},
		delete() {},
		patch() {},
		use() {}
	};
	const fakeApi = {
		app: fakeApp,
		generalLimiter: (req, res, next) => (next ? next() : undefined),
		logger: { error: () => {}, info: () => {}, warn: () => {} }
	};

	registerFeaturesRoutes(fakeApi);
	const marriageRoute = routes["/api/waifuletes/marriage-photo/:characterId"];
	assert.ok(
		marriageRoute,
		"Rota /api/waifuletes/marriage-photo/:characterId deve estar registrada no BotAPI"
	);

	// 7.1 Path traversal prevention
	let traversalStatus = null;
	let traversalResponse = "";
	await marriageRoute(
		{ params: { characterId: "../etc/passwd" } },
		{
			status(code) {
				traversalStatus = code;
				return {
					send: (msg) => {
						traversalResponse = msg;
					}
				};
			}
		}
	);
	assert.strictEqual(traversalStatus, 400, "Deve retornar 400 para tentativa de path traversal");
	console.log("✓ Path traversal barrado com HTTP 400!");

	// 7.2 Foto não existente
	let notFoundStatus = null;
	await marriageRoute(
		{ params: { characterId: "nonexistent-char-12345" } },
		{
			status(code) {
				notFoundStatus = code;
				return { send: () => {} };
			}
		}
	);
	assert.strictEqual(notFoundStatus, 404, "Deve retornar 404 para foto inexistente");
	console.log("✓ Foto inexistente tratada com HTTP 404!");

	// 7.3 Foto existente com arquivo em disco
	const path = require("path");
	const fs = require("fs").promises;
	const marriagesDir = await WaifuMarriagePhotoHelper.ensureMarriagesDir();
	const testCharId = "rem-test-photo";
	const testPhotoPath = path.join(marriagesDir, `${testCharId}.jpg`);
	await fs.writeFile(testPhotoPath, Buffer.from("fake-jpeg-content"));

	const headersSent = {};
	let fileSent = null;

	const resMock = {
		statusCode: 200,
		status(code) {
			this.statusCode = code;
			return this;
		},
		setHeader(key, val) {
			headersSent[key] = val;
		},
		send(buf) {
			fileSent = buf;
		},
		sendFile(filePath) {
			fileSent = filePath;
		}
	};

	await marriageRoute({ params: { characterId: testCharId } }, resMock);

	// Limpa arquivo de teste
	await fs.unlink(testPhotoPath).catch(() => {});

	assert.strictEqual(
		headersSent["Content-Type"],
		"image/jpeg",
		"Header Content-Type deve ser image/jpeg"
	);
	assert.strictEqual(
		headersSent["Cache-Control"],
		"public, max-age=3600",
		"Header Cache-Control deve ser public, max-age=3600"
	);
	assert.strictEqual(
		fileSent,
		testPhotoPath,
		"Deve ter enviado o caminho da foto de casamento via res.sendFile"
	);
	console.log("✓ Foto entregue com sucesso via streaming com headers corretos!");

	// Restaura mocks
	WaifuCommands.api.get = origGet;
	WaifuCommands.api.post = origPost;
	WaifuCommands.api.put = origPut;
	WaifuCommands.api.patch = origPatch;

	console.log("\n========================================================");
	console.log("🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
	console.log("========================================================");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
