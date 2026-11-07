"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando Testes do Sistema de Coleções e Link de Personagem ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();

	// 1. Validar registro dos comandos
	console.log("[Teste 1] Validando registro dos novos comandos de coleções...");
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	const cmdNames = new Set(WaifuCommands.commands.map((c) => c.name));
	assert.ok(cmdNames.has("mu-colecoes"), "Comando !mu-colecoes deve estar registrado");
	assert.ok(cmdNames.has("mu-colecao"), "Alias !mu-colecao deve estar registrado");
	assert.ok(cmdNames.has("mu-cols"), "Alias !mu-cols deve estar registrado");
	assert.ok(cmdNames.has("mu-col-nova"), "Comando !mu-col-nova deve estar registrado");
	assert.ok(cmdNames.has("mu-col-del"), "Comando !mu-col-del deve estar registrado");
	assert.ok(cmdNames.has("mu-col-add"), "Comando !mu-col-add deve estar registrado");
	assert.ok(cmdNames.has("mu-col-rem"), "Comando !mu-col-rem deve estar registrado");
	console.log("✓ Todos os comandos de coleções registrados com sucesso!");

	// Mock do axios 'api'
	const originalPost = WaifuCommands.api.post;
	const originalGet = WaifuCommands.api.get;
	const originalDelete = WaifuCommands.api.delete;

	async function waitForCaptured(targetCount, maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length >= targetCount) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 50));
		}
		return bot.capturedMessages;
	}

	// In-memory collections state for testing
	let mockCollections = [
		{
			id: "col-1",
			name: "Isekai",
			description: "Waifus de outro mundo",
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
		}
	];

	const mockHaremEntries = [
		{
			id: "h-1",
			isFavorite: true,
			keys: 10,
			collection: { id: "col-1", name: "Isekai" },
			character: {
				id: "rem-re-zero",
				name: "Rem",
				series: "Re:Zero",
				baseRarity: "LEGENDARY"
			}
		},
		{
			id: "h-2",
			isFavorite: false,
			keys: 5,
			collection: null,
			character: {
				id: "emilia-re-zero",
				name: "Emilia",
				series: "Re:Zero",
				baseRarity: "LEGENDARY"
			}
		}
	];

	WaifuCommands.api.get = async (url, config) => {
		if (url.startsWith("/characters/")) {
			const idOrQuery = decodeURIComponent(url.replace("/characters/", ""));
			if (idOrQuery === "rem-re-zero" || idOrQuery.toLowerCase().includes("rem")) {
				return {
					data: {
						success: true,
						data: {
							id: "rem-re-zero",
							name: "Rem",
							series: "Re:Zero",
							baseRarity: "LEGENDARY",
							gender: "FEMALE",
							claimCount: 42,
							likeCount: 99,
							description: "Empregada demônio leal a Subaru",
							tags: ["oni", "maid", "blue hair"],
							imageUrl: ""
						}
					}
				};
			}
			if (idOrQuery === "artoria-mythic" || idOrQuery.toLowerCase().includes("artoria")) {
				return {
					data: {
						success: true,
						data: {
							id: "artoria-mythic",
							name: "Artoria Pendragon",
							series: "Fate",
							baseRarity: "MYTHIC",
							rarity: "MYTHIC",
							isMythic: true,
							gender: "FEMALE",
							claimCount: 1,
							likeCount: 1,
							imageUrl: ""
						}
					}
				};
			}
			throw new Error("Character not found");
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
								baseRarity: "LEGENDARY",
								gender: "FEMALE",
								claimCount: 42,
								likeCount: 99
							}
						]
					}
				}
			};
		}

		if (url.includes("/collections")) {
			return {
				data: {
					success: true,
					data: mockCollections
				}
			};
		}

		if (url.startsWith("/harem/")) {
			return {
				data: {
					success: true,
					data: {
						total: mockHaremEntries.length,
						page: 1,
						totalPages: 1,
						data: mockHaremEntries
					}
				}
			};
		}

		throw new Error(`Unexpected GET url: ${url}`);
	};

	WaifuCommands.api.post = async (url, body) => {
		if (url.endsWith("/collections")) {
			const newCol = {
				id: `col-${Date.now()}`,
				name: body.name,
				description: body.description || null,
				characterCount: 0,
				characters: []
			};
			mockCollections.push(newCol);
			return {
				data: {
					success: true,
					data: newCol
				}
			};
		}

		if (url.includes("/collections/") && url.endsWith("/characters")) {
			const colId = url.split("/")[3];
			const col = mockCollections.find((c) => c.id === colId);
			if (col) {
				col.characterCount++;
				col.characters.push({
					id: body.characterId,
					name: "Rem",
					series: "Re:Zero",
					baseRarity: "LEGENDARY",
					keys: 1,
					isFavorite: false
				});
			}
			return {
				data: {
					success: true,
					data: { message: "Personagem adicionado com sucesso." }
				}
			};
		}

		throw new Error(`Unexpected POST url: ${url}`);
	};

	WaifuCommands.api.delete = async (url) => {
		if (url.includes("/collections/characters/")) {
			const charId = decodeURIComponent(url.split("/characters/")[1]);
			mockCollections.forEach((c) => {
				const idx = c.characters.findIndex((ch) => ch.id === charId);
				if (idx !== -1) {
					c.characters.splice(idx, 1);
					c.characterCount = Math.max(0, c.characterCount - 1);
				}
			});
			return {
				data: {
					success: true,
					data: { message: "Personagem removido da coleção com sucesso." }
				}
			};
		}

		if (url.includes("/collections/")) {
			const colId = url.split("/collections/")[1];
			mockCollections = mockCollections.filter((c) => c.id !== colId);
			return {
				data: {
					success: true,
					data: { message: "Coleção removida com sucesso." }
				}
			};
		}

		throw new Error(`Unexpected DELETE url: ${url}`);
	};

	try {
		// [Teste 2] !mu-char retorna link da página do personagem
		console.log("[Teste 2] Testando link de personagem em !mu-char...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgChar = createMessage({
			content: "!mu-char rem",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgChar);
		const capChar = await waitForCaptured(1);
		assert.ok(capChar.length >= 1, "Deveria capturar resposta de !mu-char");
		const charContent = capChar[0]?.content || capChar[0]?.options?.caption || "";
		assert.ok(
			charContent.includes("/character/rem-re-zero"),
			`Deveria incluir link /character/rem-re-zero, recebido: ${charContent}`
		);
		console.log("✓ !mu-char exibe link da página do personagem corretamente!");

		// [Teste 3] !mu-harem exibe coleções abaixo das favoritas
		console.log("[Teste 3] Testando exibição de coleções em !mu-harem...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgHarem = createMessage({
			content: "!mu-harem",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgHarem);
		const capHarem = await waitForCaptured(1);
		assert.ok(capHarem.length >= 1, "Deveria capturar resposta de !mu-harem");
		const haremContent = capHarem[0]?.content || "";
		assert.ok(
			haremContent.includes("⭐ *Favoritas em Destaque:*"),
			"Deveria conter cabeçalho de favoritas"
		);
		assert.ok(
			haremContent.includes("📁 *Coleções (1/15):*"),
			"Deveria conter cabeçalho de coleções"
		);
		assert.ok(
			haremContent.indexOf("📁 *Coleções") > haremContent.indexOf("⭐ *Favoritas"),
			"Coleções devem aparecer ABAIXO das favoritas"
		);
		assert.ok(haremContent.includes("📂 *Isekai* (1 waifu):"), "Deveria listar a pasta Isekai");
		assert.ok(
			haremContent.includes("└─") || haremContent.includes("├─"),
			"Deveria conter caracteres de árvore de pasta"
		);
		assert.ok(haremContent.includes("Rem"), "Deveria listar Rem dentro da pasta");
		assert.ok(haremContent.includes("💞"), "Deveria conter coração de soulmate para 10/10 chaves");
		assert.ok(
			haremContent.includes("/character/rem-re-zero"),
			"Deveria conter o link do personagem"
		);
		console.log("✓ !mu-harem exibe coleções abaixo de favoritas perfeitamente!");

		// [Teste 4] !mu-colecoes lista coleções existentes
		console.log("[Teste 4] Testando !mu-colecoes (listar pastas)...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgCols = createMessage({
			content: "!mu-colecoes",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgCols);
		const capCols = await waitForCaptured(1);
		assert.ok(capCols.length >= 1, "Deveria capturar resposta de !mu-colecoes");
		const colsContent = capCols[0]?.content || "";
		assert.ok(
			colsContent.includes("📁 *Suas Coleções de Waifus (1/15):*"),
			`Deveria listar coleções, recebido: ${colsContent}`
		);
		assert.ok(colsContent.includes("1. 📂 *Isekai* — 1 personagem(ns)"));
		console.log("✓ !mu-colecoes lista coleções corretamente!");

		// [Teste 5] !mu-colecoes Isekai lista personagens dentro da pasta
		console.log("[Teste 5] Testando !mu-colecoes <nome>...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgColDetail = createMessage({
			content: "!mu-colecoes Isekai",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgColDetail);
		const capDetail = await waitForCaptured(1);
		assert.ok(capDetail.length >= 1, "Deveria capturar resposta de !mu-colecoes Isekai");
		const colDetailContent = capDetail[0]?.content || "";
		assert.ok(colDetailContent.includes("📂 *Coleção: Isekai* (1 personagem(ns)):"));
		assert.ok(colDetailContent.includes("Rem"));
		console.log("✓ !mu-colecoes <nome> lista personagens da pasta com sucesso!");

		// [Teste 6] !mu-col-nova cria uma nova coleção
		console.log("[Teste 6] Testando !mu-col-nova...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgNovaCol = createMessage({
			content: "!mu-col-nova Shonen | Waifus de batalha",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgNovaCol);
		const capNovaCol = await waitForCaptured(1);
		assert.ok(capNovaCol.length >= 1, "Deveria capturar resposta de !mu-col-nova");
		const novaColContent = capNovaCol[0]?.content || "";
		assert.ok(
			novaColContent.includes('Coleção "Shonen" criada com sucesso!'),
			`Deveria criar coleção Shonen, recebido: ${novaColContent}`
		);
		assert.strictEqual(mockCollections.length, 2, "Deveria ter 2 coleções agora");
		console.log("✓ !mu-col-nova cria pasta com sucesso!");

		// [Teste 7] !mu-col-add adiciona personagem à coleção
		console.log("[Teste 7] Testando !mu-col-add...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgAdd = createMessage({
			content: "!mu-col-add Shonen | rem-re-zero",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgAdd);
		const capAdd = await waitForCaptured(1);
		assert.ok(capAdd.length >= 1, "Deveria capturar resposta de !mu-col-add");
		const addContent = capAdd[0]?.content || "";
		assert.ok(
			addContent.includes("foi adicionada à coleção 📂 *Shonen*!"),
			`Deveria confirmar adição, recebido: ${addContent}`
		);
		console.log("✓ !mu-col-add adiciona waifu com sucesso!");

		// [Teste 8] !mu-col-rem remove personagem da coleção
		console.log("[Teste 8] Testando !mu-col-rem...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgRem = createMessage({
			content: "!mu-col-rem rem-re-zero",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgRem);
		const capRem = await waitForCaptured(1);
		assert.ok(capRem.length >= 1, "Deveria capturar resposta de !mu-col-rem");
		const remContent = capRem[0]?.content || "";
		assert.ok(
			remContent.toLowerCase().includes("removid") && remContent.includes("coleção"),
			`Deveria confirmar remoção, recebido: ${remContent}`
		);
		console.log("✓ !mu-col-rem remove waifu com sucesso!");

		// [Teste 9] !mu-col-del apaga a coleção
		console.log("[Teste 9] Testando !mu-col-del...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgDel = createMessage({
			content: "!mu-col-del Shonen",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgDel);
		const capDel = await waitForCaptured(1);
		assert.ok(capDel.length >= 1, "Deveria capturar resposta de !mu-col-del");
		const delContent = capDel[0]?.content || "";
		assert.ok(
			delContent.includes('Coleção "Shonen" apagada com sucesso!'),
			`Deveria confirmar exclusão, recebido: ${delContent}`
		);
		assert.strictEqual(mockCollections.length, 1, "Deveria ter restado 1 coleção");
		console.log("✓ !mu-col-del apaga pasta com sucesso!");

		// [Teste 10] Míticos aparecem como primeira coleção na lista quando o usuário possui
		console.log("[Teste 10] Testando Míticos como primeira coleção em !mu-harem e !mu-colecoes...");
		mockHaremEntries.unshift({
			id: "h-mythic",
			isFavorite: false,
			keys: 0,
			collection: null,
			character: {
				id: "artoria-mythic",
				name: "Artoria Pendragon",
				series: "Fate",
				baseRarity: "MYTHIC",
				rarity: "MYTHIC",
				isMythic: true
			}
		});

		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgHaremWithMythic = createMessage({
			content: "!mu-harem",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgHaremWithMythic);
		const capHaremMythic = await waitForCaptured(1);
		assert.ok(capHaremMythic.length >= 1, "Deveria capturar resposta de !mu-harem com mítico");
		const haremMythicContent = capHaremMythic[0]?.content || "";
		assert.ok(
			haremMythicContent.includes("📂 *Míticos* (1 waifu):"),
			`Deveria listar Míticos como primeira pasta, recebido: ${haremMythicContent}`
		);
		assert.ok(
			haremMythicContent.includes("🔮 *Artoria Pendragon*"),
			"Deveria conter emoji 🔮 e nome da Artoria na coleção"
		);
		assert.ok(
			haremMythicContent.includes("/character/artoria-mythic"),
			"Deveria conter o link da waifu mítica"
		);

		// Testa !mu-colecoes com mítico
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgColsWithMythic = createMessage({
			content: "!mu-colecoes",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgColsWithMythic);
		const capColsMythic = await waitForCaptured(1);
		assert.ok(capColsMythic.length >= 1, "Deveria capturar resposta de !mu-colecoes com mítico");
		const colsMythicContent = capColsMythic[0]?.content || "";
		assert.ok(
			colsMythicContent.includes("1. 📂 🔮 *Míticos* — 1 personagem(ns)"),
			`Deveria listar pasta Míticos como número 1, recebido: ${colsMythicContent}`
		);
		assert.ok(
			colsMythicContent.includes("2. 📂 *Isekai*"),
			`Deveria listar pasta Isekai como número 2, recebido: ${colsMythicContent}`
		);

		// Testa ver pasta Míticos: !mu-colecoes miticos
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgVerMiticos = createMessage({
			content: "!mu-colecoes miticos",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgVerMiticos);
		const capVerMiticos = await waitForCaptured(1);
		assert.ok(capVerMiticos.length >= 1, "Deveria capturar resposta de !mu-colecoes miticos");
		const verMiticosContent = capVerMiticos[0]?.content || "";
		assert.ok(
			verMiticosContent.includes("📂 *Coleção: Míticos*"),
			`Deveria exibir cabeçalho de Míticos, recebido: ${verMiticosContent}`
		);
		assert.ok(
			verMiticosContent.includes("🔮 *Artoria Pendragon*"),
			"Deveria exibir Artoria com 🔮"
		);
		assert.ok(
			verMiticosContent.includes("/character/artoria-mythic"),
			"Deveria exibir o link web de Artoria"
		);
		console.log("✓ Míticos como primeira coleção em !mu-harem e !mu-colecoes verificado!");

		// [Teste 11] !mu-col-add com waifu mítica deve ser rejeitado
		console.log("[Teste 11] Testando bloqueio de adicionar mítico em pasta...");
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();
		const msgAddMythic = createMessage({
			content: "!mu-col-add Isekai | artoria-mythic",
			author: "5511999999999@s.whatsapp.net",
			group: "120363000000000000@g.us"
		});
		await eventHandler.processMessage(bot, msgAddMythic);
		const capAddMythic = await waitForCaptured(1);
		assert.ok(
			capAddMythic.length >= 1,
			"Deveria capturar resposta de erro para !mu-col-add mítico"
		);
		const addMythicContent = capAddMythic[0]?.content || "";
		assert.ok(
			addMythicContent.includes(
				"Personagens míticos não podem ser colocados em coleções ou pastas"
			),
			`Deveria conter mensagem de bloqueio, recebido: ${addMythicContent}`
		);
		console.log("✓ Bloqueio de adicionar mítico a coleções verificado com sucesso!");

		console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! 🎉");
		process.exit(0);
	} catch (err) {
		console.error("❌ ERRO NO TESTE:", err);
		process.exit(1);
	} finally {
		WaifuCommands.api.get = originalGet;
		WaifuCommands.api.post = originalPost;
		WaifuCommands.api.delete = originalDelete;
	}
}

runTests();
